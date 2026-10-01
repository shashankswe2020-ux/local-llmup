require 'json'
require 'net/http'
require 'open3'
require 'digest'
require 'fileutils'
require 'timeout'
require 'cgi'

def percentile(values, fraction)
  raise 'empty measurements' if values.empty?
  values.sort[(fraction * values.length).ceil - 1]
end

def score_answer(text, expected)
  text.strip == expected ? 1 : 0
end

if ARGV == ['--self-test']
  raise 'median' unless percentile([4, 1, 3, 2], 0.5) == 2
  raise 'p95' unless percentile((1..30).to_a, 0.95) == 29
  raise 'correct answer' unless score_answer(" 42\n", '42') == 1
  raise 'extra explanation accepted' unless score_answer('42 because...', '42') == 0
  puts 'PASS: percentile and strict task scoring checks'
  exit
end

root, bonsai_path, qwen_path = ARGV
abort 'Usage: ruby scripts/bonsai-comparison.rb OUTPUT_DIR BONSAI_GGUF QWEN_GGUF' unless ARGV.length == 3
FileUtils.mkdir_p(root, mode: 0700)
models = {
  'bonsai' => {name: 'Bonsai 8B Q1_0', path: bonsai_path, sha256: '284a335aa3fb2ced3b1b01fcb40b08aa783e3b70832767f0dd2e3fdfa134bd54'},
  'qwen' => {name: 'Qwen3 8B Q4_K_M', path: qwen_path, sha256: 'd98cdcbd03e17ce47681435b5150e34c1417f50b5c0019dd560e4882c5745785'}
}
models.each_value do |model|
  abort "Digest mismatch: #{model[:name]}" unless Digest::SHA256.file(model[:path]).hexdigest == model[:sha256]
  model[:bytes] = File.size(model[:path])
end
port = 48343
server = '/opt/homebrew/opt/llama.cpp/bin/llama-server'
origin = "http://127.0.0.1:#{port}"

def request_json(origin, path, payload = nil)
  uri = URI(origin + path)
  request = payload ? Net::HTTP::Post.new(uri) : Net::HTTP::Get.new(uri)
  request['Content-Type'] = 'application/json'
  request.body = JSON.generate(payload) if payload
  response = Net::HTTP.start(uri.host, uri.port, nil, open_timeout: 3, read_timeout: 120) { |http| http.request(request) }
  raise "HTTP #{response.code} at #{path}" unless response.code == '200'
  raise 'oversized JSON response' if response.body.bytesize > 4 * 1024 * 1024
  JSON.parse(response.body)
end

def completion(origin, tokens, maximum, fixed_length)
  uri = URI(origin + '/completion')
  request = Net::HTTP::Post.new(uri)
  request['Content-Type'] = 'application/json'
  request.body = JSON.generate(prompt: tokens, n_predict: maximum, stream: true,
    temperature: 0, seed: 42, cache_prompt: false, ignore_eos: fixed_length)
  started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  first_token = nil
  content = ''
  timings = nil
  pending = ''
  Net::HTTP.start(uri.host, uri.port, nil, open_timeout: 3, read_timeout: 120) do |http|
    http.request(request) do |response|
      raise "completion HTTP #{response.code}" unless response.code == '200'
      response.read_body do |chunk|
        pending << chunk
        raise 'oversized stream' if pending.bytesize + content.bytesize > 1024 * 1024
        while (boundary = pending.index("\n\n"))
          event = pending.slice!(0, boundary + 2)
          event.lines.grep(/^data: /).each do |line|
            data = line.delete_prefix('data: ').strip
            next if data == '[DONE]'
            parsed = JSON.parse(data)
            raise 'inference error' if parsed['error']
            piece = parsed.fetch('content', '')
            first_token ||= Process.clock_gettime(Process::CLOCK_MONOTONIC) unless piece.empty?
            content << piece
            timings = parsed['timings'] if parsed['timings']
          end
        end
      end
    end
  end
  raise 'missing completion timings' unless timings && first_token
  {ttft_seconds: first_token - started, wall_seconds: Process.clock_gettime(Process::CLOCK_MONOTONIC) - started,
   decode_tps: timings.fetch('predicted_per_second'), prompt_tps: timings.fetch('prompt_per_second'),
   output_tokens: timings.fetch('predicted_n'), prompt_tokens: timings.fetch('prompt_n'),
   cached_tokens: timings.fetch('cache_n'), timings: timings, content: content}
end

def prompt_tokens(origin, text, target = nil)
  messages = [{role: 'system', content: 'Follow the user instructions precisely. Be concise.'}, {role: 'user', content: text}]
  template = request_json(origin, '/apply-template', {messages: messages, chat_template_kwargs: {enable_thinking: false}}).fetch('prompt')
  tokens = request_json(origin, '/tokenize', {content: template, add_special: true}).fetch('tokens')
  return tokens unless target
  raise 'base prompt exceeds target' if tokens.length >= target
  padding = request_json(origin, '/tokenize', {content: "Reference material: ordinary archival notes about weather and geography.\n", add_special: false}).fetch('tokens')
  (padding * ((target - tokens.length) / padding.length + 1)).first(target - tokens.length) + tokens
end

quality_tasks = [
  ['math', 'What is 17 multiplied by 24? Reply with only the integer.', '408'],
  ['math', 'A price of 80 is discounted by 15 percent. Reply with only the final price as an integer.', '68'],
  ['math', 'What is the next integer: 2, 6, 12, 20, 30? Reply with only the integer.', '42'],
  ['math', 'Three identical machines make 18 parts in two hours. How many parts do five machines make in four hours? Reply with only the integer.', '60'],
  ['logic', 'All dax are wugs. No wugs are zibs. Can any dax be a zib? Reply only yes or no.', 'no'],
  ['logic', 'Some painters are swimmers. All swimmers are runners. Must some painters be runners? Reply only yes or no.', 'yes'],
  ['logic', 'Alice is taller than Bob. Bob is taller than Chen. Who is shortest? Reply with only the name.', 'Chen'],
  ['logic', 'If it rains the road is wet. The road is wet. Does this prove it rained? Reply only yes or no.', 'no'],
  ['code', 'In Rust, what integer does (0..5).filter(|number| number % 2 == 0).sum::<i32>() produce? Reply only with the integer.', '6'],
  ['code', 'In Rust, what is the value of -7 % 3? Reply only with the integer.', '-1'],
  ['code', 'A Python list starts as [1,2,3]. After values.append(values.pop(0)), what is values? Reply exactly in compact JSON array format.', '[2,3,1]'],
  ['code', 'In Rust, let mut total = 0; for number in 1..4 { total += number; } What is total? Reply only with the integer.', '6'],
  ['instructions', 'Return the word kiwi exactly three times separated by commas with no spaces or other text.', 'kiwi,kiwi,kiwi'],
  ['instructions', 'Sort these integers in ascending order: 9, -2, 4, 0. Reply as a compact JSON array, without spaces.', '[-2,0,4,9]'],
  ['instructions', 'Output only a JSON object with key ok and boolean value true, without spaces.', '{"ok":true}'],
  ['instructions', 'Reply with exactly the lowercase word confirmed, and nothing else.', 'confirmed'],
  ['grounding', 'Record: Project Cedar launches on May 8. Project Maple launches on June 2. Which project launches on June 2? Reply only the project name without the word Project.', 'Maple'],
  ['grounding', 'Record: Invoice A totals 90; Invoice B totals 120; Invoice C totals 75. Which invoice has the largest total? Reply only A, B, or C.', 'B'],
  ['grounding', 'Record: Mira owns the blue folder. Jo owns the red folder. Who owns the green folder? Reply exactly unknown if not stated.', 'unknown'],
  ['grounding', 'Record: Ticket T1 is closed. Ticket T2 is open. Ticket T3 is closed. Return only the open ticket ID.', 'T2']
]
workloads = {
  'short-chat' => ['Explain why leaves change color in autumn in a concise paragraph.', nil],
  'summarization' => ["Summarize these meeting notes in three bullet points: The release is delayed by two days. Mira owns testing. Jo owns deployment. The critical issue is fixed. Documentation review remains open. The next check-in is Friday.\n" * 12, nil],
  'coding' => ['Write a Rust function that returns the largest value in a slice of i32 as Option<i32>, and explain how it handles an empty slice.', nil],
  'context-4k' => ['Explain the distinction between weather and climate in a short paragraph.', 4096],
  'context-16k' => ['Explain the distinction between weather and climate in a short paragraph.', 16384]
}
report = {schemaVersion: 1, title: 'Bonsai vs Qwen3: measured speed and task accuracy',
  hardware: 'Apple M4 Max, 14 CPU cores, 32 GPU cores, 36 GB RAM, macOS 26.5',
  runtime: 'llama.cpp b10090 (7347430f4), Metal',
  settings: {context: 17408, slots: 1, gpu_layers: 99, threads: 10, flash_attention: 'off', kv: 'f16', thinking: false,
    speed_output_tokens: 128, quality_output_limit: 256, temperature: 0, seed: 42, cache_prompt: false,
    repetitions_per_workload: 30, order: %w[bonsai qwen qwen bonsai bonsai qwen]},
  caveats: ['Local illustrative tasks, not general intelligence or a published benchmark.',
    'Exact-answer scoring includes instruction-format compliance; raw answers are retained.',
    'Quality uses 20 unique tasks once per model; repeated speed samples do not enlarge the quality sample.',
    'Long-context speed uses token padding, not a long-context understanding evaluation.',
    'Fixed-length speed requests ignore EOS; quality requests allow natural completion.',
    'Desktop remains in normal use; thermal state and GPU power are unmeasured.',
    'RSS excludes some Metal allocations. No FP16, energy, or other-hardware claims are verified.'],
  models: models, samples: [], quality: [], errors: [], runs: []}
persist = -> { File.write(File.join(root, 'results.json'), JSON.pretty_generate(report)) }
persist.call
raise 'benchmark port already occupied' if system('/usr/sbin/lsof', '-nP', "-iTCP:#{port}", '-sTCP:LISTEN', out: File::NULL)
%w[bonsai qwen qwen bonsai bonsai qwen].each_with_index do |model_id, block|
  model = models.fetch(model_id)
  log = File.open(File.join(root, "server-#{block}-#{model_id}.log"), 'w', 0600)
  started = Process.clock_gettime(Process::CLOCK_MONOTONIC)
  pid = Process.spawn(server, '-m', model[:path], '--alias', model_id, '--host', '127.0.0.1', '--port', port.to_s,
    '-c', '17408', '-np', '1', '-t', '10', '-tb', '10', '-ngl', '99', '-fa', 'off', '-ctk', 'f16', '-ctv', 'f16',
    '--reasoning', 'off', '--chat-template-kwargs', '{"enable_thinking":false}', out: log, err: log)
  begin
    Timeout.timeout(120) do
      loop do
        raise 'server exited before readiness' if Process.waitpid(pid, Process::WNOHANG)
        begin
          break if request_json(origin, '/health')['status'] == 'ok'
        rescue Errno::ECONNREFUSED, RuntimeError
          IO.select(nil, nil, nil, 0.2)
        end
      end
    end
    identity = request_json(origin, '/v1/models')
    raise 'wrong model identity' unless identity.fetch('data').any? { |entry| entry['id'] == model_id }
    listener, status = Open3.capture2('/usr/sbin/lsof', '-nP', '-a', '-p', pid.to_s, "-iTCP:#{port}", '-sTCP:LISTEN', '-Fn')
    raise 'listener identity mismatch' unless status.success? && listener.include?("n127.0.0.1:#{port}")
    report[:runs] << {model: model_id, block: block, startup_seconds: Process.clock_gettime(Process::CLOCK_MONOTONIC) - started,
      props: request_json(origin, '/props').slice('model_path', 'total_slots', 'default_generation_settings')}
    prepared = workloads.transform_values { |text, target| prompt_tokens(origin, text, target) }
    prepared.each { |_, tokens| completion(origin, tokens, 128, true) }
    10.times do |iteration|
      prepared.to_a.rotate(iteration % prepared.length).each do |name, tokens|
        sample = completion(origin, tokens, 128, true)
        raise 'unexpected output length' unless sample[:output_tokens] == 128
        raise 'prompt cache invalidates trial' unless sample[:cached_tokens] == 0
        rss, = Open3.capture2('/bin/ps', '-p', pid.to_s, '-o', 'rss=')
        report[:samples] << sample.merge(model: model_id, workload: name, block: block, iteration: iteration, rss_kib: Integer(rss.strip))
        persist.call
      end
      puts "Block #{block + 1}/6 #{model_id}: #{iteration + 1}/10 workload sets completed"
      STDOUT.flush
    end
    unless report[:quality].any? { |entry| entry[:model] == model_id }
      quality_tasks.each_with_index do |(category, prompt, expected), index|
        sample = completion(origin, prompt_tokens(origin, prompt), 256, false)
        report[:quality] << sample.merge(model: model_id, task: index + 1, category: category, prompt: prompt, expected: expected,
          passed: score_answer(sample[:content], expected) == 1, truncated: sample[:output_tokens] >= 256)
        persist.call
      end
    end
  rescue StandardError => error
    report[:errors] << {model: model_id, block: block, error: error.message}
    persist.call
    raise
  ensure
    begin
      Process.kill('TERM', pid)
      Timeout.timeout(15) { Process.waitpid(pid) }
    rescue Timeout::Error
      Process.kill('KILL', pid)
      Process.waitpid(pid)
    rescue Errno::ESRCH, Errno::ECHILD
    end
    log.close
  end
end
report[:summary] = models.keys.to_h do |model_id|
  rows = workloads.keys.to_h do |name|
    samples = report[:samples].select { |entry| entry[:model] == model_id && entry[:workload] == name }
    raise 'incomplete workload' unless samples.length == 30
    [name, {count: samples.length, prompt_tokens: samples.map { |entry| entry[:prompt_tokens] }.uniq,
      median_ttft: percentile(samples.map { |entry| entry[:ttft_seconds] }, 0.5),
      p95_ttft: percentile(samples.map { |entry| entry[:ttft_seconds] }, 0.95),
      median_decode_tps: percentile(samples.map { |entry| entry[:decode_tps] }, 0.5),
      median_wall: percentile(samples.map { |entry| entry[:wall_seconds] }, 0.5),
      p95_wall: percentile(samples.map { |entry| entry[:wall_seconds] }, 0.95),
      max_rss_gib: samples.map { |entry| entry[:rss_kib] / 1048576.0 }.max}]
  end
  quality = report[:quality].select { |entry| entry[:model] == model_id }
  [model_id, {workloads: rows, correct: quality.count { |entry| entry[:passed] }, total: quality.length}]
end
report[:completedAt] = Time.now.utc.strftime('%Y-%m-%dT%H:%M:%SZ')
persist.call
puts JSON.pretty_generate(report[:summary])
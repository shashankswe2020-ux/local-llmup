require 'json'
require 'net/http'
require 'uri'
require 'digest'
require 'fileutils'
require 'time'

def allowed_source?(raw)
  url = URI(raw)
  url.is_a?(URI::HTTPS) && ['huggingface.co', 'registry.ollama.ai'].include?(url.host) && url.port == 443 && url.userinfo.nil? && url.fragment.nil?
rescue URI::InvalidURIError
  false
end

def config_facts(config)
  text = config.fetch('text_config', config)
  raise 'invalid text config' unless text.is_a?(Hash)
  {
    'modelType' => text['model_type'],
    'context' => text['max_position_embeddings'] || text['max_sequence_length'] || text['seq_length'],
    'experts' => text['num_local_experts'] || text['n_routed_experts'] || text['num_experts'],
    'activeExperts' => text['num_experts_per_tok'] || text['num_experts_per_token'],
    'layers' => text['num_hidden_layers'],
    'attentionHeads' => text['num_attention_heads'],
    'kvHeads' => text['num_key_value_heads'],
    'headDimension' => text['head_dim'],
    'hiddenSize' => text['hidden_size'],
    'ropeScaling' => text['rope_scaling'],
    'layerTypes' => text['layer_types']
  }
end

def authorization_for(raw, token)
  return nil unless allowed_source?(raw) && URI(raw).host == 'huggingface.co' && token && !token.empty?
  raise 'invalid HF_TOKEN format' if token.bytesize > 4096 || token.match?(/[[:cntrl:]]/)
  "Bearer #{token}"
end

def gated_entry?(entry)
  entry.fetch('sources').any? { |source| [401, 403].include?(source['status']) }
end

def fetch_source(raw, remaining = 3)
  raise 'unapproved source URL' unless allowed_source?(raw)
  url = URI(raw)
  response_code = nil
  redirect = nil
  body = ''.b
  Net::HTTP.start(url.host, url.port, nil, use_ssl: true, open_timeout: 10, read_timeout: 30) do |http|
    request = Net::HTTP::Get.new(url)
    request['User-Agent'] = 'RigSpark-Catalog-Audit/1.0'
    authorization = authorization_for(raw, ENV['HF_TOKEN'])
    request['Authorization'] = authorization if authorization
    http.request(request) do |response|
      response_code = response.code.to_i
      if response.is_a?(Net::HTTPRedirection)
        redirect = URI.join(raw, response.fetch('location')).to_s
      else
        response.read_body do |chunk|
          raise 'source exceeds 2 MiB' if body.bytesize + chunk.bytesize > 2 * 1024 * 1024
          body << chunk
        end
      end
    end
  end
  if redirect
    raise 'redirect limit' unless remaining.positive?
    raise 'cross-host redirect refused' unless URI(redirect).host == url.host
    return fetch_source(redirect, remaining - 1)
  end
  raise 'rate limited; stop and resume later' if response_code == 429
  {'url' => raw, 'status' => response_code, 'checkedAt' => Time.now.utc.iso8601,
   'sha256' => Digest::SHA256.hexdigest(body), 'body' => body.force_encoding(Encoding::UTF_8)}
end

def source_json(source)
  raise "HTTP #{source.fetch('status')}" unless source['status'] == 200
  value = JSON.parse(source.fetch('body'))
  raise 'expected JSON object' unless value.is_a?(Hash)
  value
end

if ARGV == ['--self-test']
  raise 'public source rejected' unless allowed_source?('https://huggingface.co/Qwen/Test/raw/abc/config.json')
  ['http://huggingface.co/test', 'https://evil.example/test', 'https://user:pass@huggingface.co/test', 'https://huggingface.co:8443/test'].each do |url|
    raise 'unsafe source accepted' if allowed_source?(url)
  end
  raise 'nested context' unless config_facts({'text_config' => {'max_position_embeddings' => 32768}})['context'] == 32768
  raise 'unknown context fabricated' unless config_facts({})['context'].nil?
  raise 'HF authorization absent' unless authorization_for('https://huggingface.co/api/models/example/model', 'test-token') == 'Bearer test-token'
  raise 'token leaked to registry' unless authorization_for('https://registry.ollama.ai/v2/library/model/manifests/latest', 'test-token').nil?
  raise 'token leaked to insecure URL' unless authorization_for('http://huggingface.co/test', 'test-token').nil?
  raise 'empty token sent' unless authorization_for('https://huggingface.co/test', '').nil?
  raise 'gated entry not retryable' unless gated_entry?({'sources' => [{'status' => 401}]})
  raise 'successful entry retried' if gated_entry?({'sources' => [{'status' => 200}]})
  puts 'PASS: public-source bounds and config facts'
  exit
end

retry_gated = ARGV.delete('--retry-gated')
abort 'Usage: ruby scripts/catalog-hf-audit.rb CATALOG_JSON OUTPUT_DIRECTORY [--retry-gated]' unless ARGV.length == 2
catalog_path, root = ARGV
catalog_raw = File.read(catalog_path)
catalog = JSON.parse(catalog_raw)
FileUtils.mkdir_p(root)
report_path = File.join(root, 'report.json')
report = File.exist?(report_path) ? JSON.parse(File.read(report_path)) : {
  'schemaVersion' => 1, 'catalogSha256' => Digest::SHA256.hexdigest(catalog_raw),
  'requiresReview' => true, 'entries' => []
}
abort 'catalog changed since audit started; use a new directory' unless report['catalogSha256'] == Digest::SHA256.hexdigest(catalog_raw)
catalog.fetch('models').each_with_index do |model, index|
  previous = report['entries'].find { |entry| entry['id'] == model['id'] }
  next if previous && !(retry_gated && gated_entry?(previous))
  entry = {'id' => model.fetch('id'), 'sources' => [], 'issues' => [], 'requiresReview' => true}
  capture = lambda do |url|
    source = fetch_source(url)
    entry['sources'] << source
    source
  end
  begin
    repo = model.fetch('source').fetch('hf')
    raise 'invalid repository coordinates' unless repo.match?(/\A[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*\z/)
    current = source_json(capture.call("https://huggingface.co/api/models/#{repo}"))
    revision = current.fetch('sha')
    raise 'invalid revision' unless revision.match?(/\A[0-9a-f]{40}\z/)
    entry['revision'] = revision
    metadata = source_json(capture.call("https://huggingface.co/api/models/#{repo}/revision/#{revision}"))
    raise 'revision mismatch' unless metadata['sha'] == revision
    entry['license'] = metadata.dig('cardData', 'license')
    entry['licenseName'] = metadata.dig('cardData', 'license_name')
    entry['tensorParameters'] = metadata.dig('safetensors', 'total') || metadata.dig('gguf', 'total')
    entry['pipelineTag'] = metadata['pipeline_tag']
    entry['issues'] << 'license needs reconciliation' if entry['license'] != model['license']
    config = capture.call("https://huggingface.co/#{repo}/raw/#{revision}/config.json")
    if config['status'] == 200
      entry['config'] = config_facts(source_json(config))
      entry['issues'] << 'config context differs; inspect card/scaling and artifact identity' if entry['config']['context'] && entry['config']['context'] != model['contextLength']
    else
      entry['issues'] << "config inaccessible: HTTP #{config['status']}"
    end
    card = capture.call("https://huggingface.co/#{repo}/raw/#{revision}/README.md")
    entry['issues'] << "card inaccessible: HTTP #{card['status']}" unless card['status'] == 200
    reference = model.fetch('source')['ollama']
    if reference
      repository, tag = reference.split(':', 2)
      repository = "library/#{repository}" unless repository.include?('/')
      tag ||= 'latest'
      raise 'invalid registry coordinates' unless repository.match?(/\A[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+\z/) && tag.match?(/\A[A-Za-z0-9._-]+\z/)
      manifest = source_json(capture.call("https://registry.ollama.ai/v2/#{repository}/manifests/#{tag}"))
      layers = manifest.fetch('layers').select { |layer| ['application/vnd.ollama.image.model', 'application/vnd.ollama.image.projector'].include?(layer['mediaType']) }
      entry['artifactLayers'] = layers
      quant = model.fetch('quantizations').first
      entry['issues'] << 'artifact bytes differ' unless layers.sum { |layer| layer.fetch('size') } == quant['diskBytes']
      weight = layers.find { |layer| layer['mediaType'] == 'application/vnd.ollama.image.model' }
      entry['issues'] << 'weight digest differs' unless weight && weight['digest'] == "sha256:#{quant['sha256']}"
    end
  rescue StandardError => error
    raise if error.message.start_with?('rate limited')
    entry['issues'] << error.message
  end
  report['entries'].delete(previous) if previous
  report['entries'] << entry
  File.write(report_path, JSON.pretty_generate(report) + "\n")
  puts "#{index + 1}/#{catalog.fetch('models').length} #{entry['id']}: #{entry['issues'].empty? ? 'sources captured; review required' : entry['issues'].join('; ')}"
  STDOUT.flush
end
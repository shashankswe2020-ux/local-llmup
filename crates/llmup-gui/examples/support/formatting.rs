use super::{TestResult, click, fresh_session, send, wait_for};
use fantoccini::{Client, Locator};
use serde_json::json;

const LAST_REPLY: &str =
    "[...document.querySelectorAll('.message.assistant .message-body')].at(-1)";

async fn failures(client: &Client, label: &str, checks: &str) -> TestResult {
    let script = format!(
        "const body = {LAST_REPLY}; const failed = []; const check = (name, ok) => {{ if (!ok) failed.push(name); }}; const count = (selector) => body.querySelectorAll(selector).length; {checks}; return failed;"
    );
    let failed = client.execute(&script, vec![]).await?;
    if failed != json!([]) {
        return Err(format!("{label} failed: {failed}").into());
    }
    Ok(())
}

async fn number(client: &Client, expression: &str) -> Result<f64, Box<dyn std::error::Error>> {
    client
        .execute(&format!("return {expression};"), vec![])
        .await?
        .as_f64()
        .ok_or_else(|| format!("{expression} is not a number").into())
}

async fn formatted_reply(client: &Client, origin: &str) -> TestResult {
    client.goto(origin).await?;
    fresh_session(client).await?;
    send(client, "FORMAT_MARKDOWN").await?;
    wait_for(client, "document.querySelectorAll('.message.assistant .code-copy').length === 3 && !document.querySelector('.message.assistant.streaming')").await
}

async fn held_log(client: &Client) -> Result<f64, Box<dyn std::error::Error>> {
    client
        .execute(
            "const style = document.createElement('style'); style.textContent = '#messages { flex: 0 0 18rem; min-height: 0; }'; document.head.append(style);",
            vec![],
        )
        .await?;
    wait_for(client, "document.querySelector('#messages').scrollHeight > document.querySelector('#messages').clientHeight").await?;
    client
        .execute(
            "document.querySelector('#messages').scrollTop = 80;",
            vec![],
        )
        .await?;
    number(client, "document.querySelector('#messages').scrollTop").await
}

fn near(label: &str, actual: f64, held: f64) -> TestResult {
    if (actual - held).abs() < 8.0 {
        Ok(())
    } else {
        Err(format!("{label}: scroll moved from {held} to {actual}").into())
    }
}

async fn affordances(client: &Client, viewport: &str) -> TestResult {
    failures(client, &format!("{viewport} affordances"), "
        check('languages', JSON.stringify([...body.querySelectorAll('.code-language')].map((node) => node.textContent.trim())) === JSON.stringify(['typescript', 'bash', 'html']));
        check('preview', count('.code-preview') === 1);
        check('copy', count('.code-copy') === 3);
        const copy = body.querySelector('.code-copy');
        const table = body.querySelector('.markdown-table-wrap');
        check('measure', body.getBoundingClientRect().width / Number.parseFloat(getComputedStyle(body).fontSize) <= 80);
        check('copy opacity', Number.parseFloat(getComputedStyle(copy).opacity) === 1);
        check('table overflow', table.scrollWidth >= table.clientWidth);
        check('page overflow', document.documentElement.scrollWidth <= innerWidth)
    ").await
}

pub async fn desktop(client: &Client, origin: &str) -> TestResult {
    formatted_reply(client, origin).await?;
    failures(client, "GFM semantics", r#"
        const user = [...document.querySelectorAll('.message.user .message-body')].at(-1);
        const heading = (level, name) => [...body.querySelectorAll('h' + level)].some((node) => node.textContent.trim() === name && node.getClientRects().length > 0);
        check('h1', heading(1, 'Deployment result'));
        check('h2', heading(2, 'Checklist'));
        check('nested', count('ul ul li') === 2);
        check('checkboxes', count('input[type="checkbox"]') === 2);
        check('tasks', count('.contains-task-list > .task-list-item') === 2);
        check('task marker', getComputedStyle(body.querySelector('.task-list-item')).listStyleType === 'none');
        check('quote', count('blockquote p') === 2);
        check('th', count('table thead th') === 3);
        check('tr', count('table tbody tr') === 2);
        check('hr', count('hr') === 1);
        check('ts', body.querySelector('pre code.language-typescript')?.textContent.includes('greet'));
        check('bash', body.querySelector('pre code.language-bash')?.textContent.includes('npm run build'));
        check('html', body.querySelector('pre code.language-html')?.textContent.includes('<main'));
        check('del', body.querySelector('del')?.textContent === 'removed text');
        check('link rel', body.querySelector('a[href="https://example.com/docs?q=local"]')?.getAttribute('rel') === 'noopener noreferrer');
        check('data image', count('img[src^="data:image/png;base64,"]') === 1);
        check('local image', count('img[src="/api/images/formatting.png"]') === 1);
        for (const selector of ['img[src^="https://"]', 'img[src^="file:"]', 'img[src^="data:text/html"]', 'a[href^="javascript:"]', 'a[href^="data:"]', '#unsafe, script, svg, [style], [onload], [onerror], [onmouseover]']) {
            check(selector, count(selector) === 0);
        }
        for (const text of ['<button id="unsafe"', 'Remote image', 'File image', 'HTML data image']) {
            check(text, body.textContent.includes(text));
        }
        check('xss', globalThis.__xss !== true);
        check('user plain', user.querySelectorAll('h1, ul, pre, table').length === 0 && user.textContent.trim() === 'FORMAT_MARKDOWN')
    "#).await?;

    failures(client, "semantic structure", "
        check('h1', count('h1') === 1);
        check('h2', count('h2') === 1);
        check('lists', count('ul, ol') === 4);
        check('items', count('li') === 8);
        check('table', count('table') === 1);
        check('blockquote', count('blockquote') === 1);
        for (const name of ['Copy code', 'Preview HTML code']) {
            const button = [...body.querySelectorAll('button')].find((node) => (node.getAttribute('aria-label') || node.textContent).includes(name));
            button?.focus();
            check(name + ' focus', button && document.activeElement === button && getComputedStyle(button).outlineStyle !== 'none');
        }
    ").await?;

    let original = client
        .execute(&format!("return {LAST_REPLY}.textContent;"), vec![])
        .await?;
    client.refresh().await?;
    wait_for(
        client,
        &format!("{LAST_REPLY}?.querySelectorAll('table').length === 1"),
    )
    .await?;
    let restored = client
        .execute(&format!("const body = {LAST_REPLY}; return body.querySelectorAll('blockquote').length === 1 ? body.textContent : null;"), vec![])
        .await?;
    if restored != original
        || !original
            .as_str()
            .is_some_and(|text| text.contains("Deployment result"))
    {
        return Err("restored formatted reply differs from the original".into());
    }

    let expected = client
        .execute(&format!("return {LAST_REPLY}.innerHTML;"), vec![])
        .await?;
    fresh_session(client).await?;
    send(client, "FORMAT_MARKDOWN_STREAM").await?;
    wait_for(client, &format!("{LAST_REPLY}?.querySelectorAll('table').length === 1 && {LAST_REPLY}.querySelectorAll('.code-copy').length === 3 && !document.querySelector('.message.assistant.streaming')")).await?;
    let streamed = client
        .execute(&format!("return {LAST_REPLY}.innerHTML;"), vec![])
        .await?;
    if streamed != expected {
        return Err("streamed Markdown did not converge to the complete DOM".into());
    }

    formatted_reply(client, origin).await?;
    let held = held_log(client).await?;
    send(client, "FORMAT_MARKDOWN_SCROLL").await?;
    wait_for(client, "[...document.querySelectorAll('.message.assistant.streaming')].at(-1)?.getClientRects().length > 0").await?;
    if number(client, "document.querySelector('#messages').scrollTop").await? != held {
        return Err("message log moved when streaming started".into());
    }
    wait_for(
        client,
        "!document.querySelector('.message.assistant.streaming')",
    )
    .await?;
    near(
        "log after streaming",
        number(client, "document.querySelector('#messages').scrollTop").await?,
        held,
    )?;

    formatted_reply(client, origin).await?;
    let held = held_log(client).await?;
    send(client, "cancel this response").await?;
    click(client, ".send-btn.is-stop").await?;
    wait_for(
        client,
        "document.querySelector('.run-notice')?.textContent.includes('Stopped.')",
    )
    .await?;
    near(
        "cancellation notice",
        number(client, "document.querySelector('#messages').scrollTop").await?,
        held,
    )?;

    client.goto(origin).await?;
    fresh_session(client).await?;
    send(client, "FORMAT_MARKDOWN_INCOMPLETE").await?;
    wait_for(client, "(() => { const row = [...document.querySelectorAll('.message.assistant')].at(-1); return row?.classList.contains('streaming') && row.querySelector('pre code.language-typescript')?.textContent.includes('const') && row.querySelectorAll('.code-copy').length === 0; })()").await?;
    wait_for(client, "(() => { const row = [...document.querySelectorAll('.message.assistant')].at(-1); return row && !row.classList.contains('streaming') && row.querySelector('pre code.language-typescript')?.textContent.includes('const value = 1;') && row.querySelectorAll('.code-copy').length === 1 && row.textContent.includes('After the code.'); })()").await?;

    formatted_reply(client, origin).await?;
    click(client, ".message.assistant .code-preview").await?;
    wait_for(client, "(() => { const frame = document.querySelector('#artifact-frame'); return document.querySelector('#artifact-modal')?.getClientRects().length > 0 && frame.getAttribute('sandbox') === '' && /<main class=\"status\">Ready<\\/main>/u.test(frame.getAttribute('srcdoc') || ''); })()").await?;
    click(client, "#artifact-close").await?;
    wait_for(client, "document.querySelector('#artifact-modal')?.getClientRects().length === 0 && document.activeElement?.classList.contains('code-preview')").await?;

    client.set_window_size(1440, 900).await?;
    formatted_reply(client, origin).await?;
    affordances(client, "desktop").await
}

pub async fn viewport(client: &Client, origin: &str, width: u32) -> TestResult {
    formatted_reply(client, origin).await?;
    affordances(client, &format!("{width}px")).await?;
    if width != 390 {
        return Ok(());
    }
    failures(
        client,
        "narrow tables",
        "
        check('wrapped table', count('.markdown-table-wrap > table') === 1);
        check('page overflow', document.documentElement.scrollWidth <= 390)
    ",
    )
    .await?;

    let prompt = client.find(Locator::Css("#prompt")).await?;
    prompt.clear().await?;
    prompt.send_keys("FORMAT_MARKDOWN_SCROLL").await?;
    client
        .execute("window.scrollTo(0, document.documentElement.scrollHeight); window.__llmupTestRun = true;", vec![])
        .await?;
    prompt.send_keys("\u{e007}").await?;
    wait_for(client, "[...document.querySelectorAll('.message.assistant')].at(-1)?.classList.contains('streaming')").await?;
    wait_for(client, "(() => { const scroller = document.scrollingElement; return scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 8; })()").await?;
    client.execute("window.scrollTo(0, 200);", vec![]).await?;
    let held = number(client, "window.scrollY").await?;
    wait_for(
        client,
        "!document.querySelector('.message.assistant.streaming')",
    )
    .await?;
    near(
        "reader position",
        number(client, "window.scrollY").await?,
        held,
    )
}

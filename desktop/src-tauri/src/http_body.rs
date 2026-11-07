//! Receive budgets apply before buffering, including chunked and error responses.
pub(crate) const MCP_BYTES: usize = 256 * 1024 * 1024;
pub(crate) const DIAGNOSTIC_BYTES: usize = 4096;

pub(crate) async fn bytes(
    mut response: reqwest::Response,
    maximum: usize,
) -> Result<Vec<u8>, String> {
    if response
        .content_length()
        .is_some_and(|n| n > maximum as u64)
    {
        return Err("响应超过接收上限".into());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| "响应读取中断")? {
        if chunk.len() > maximum.saturating_sub(body.len()) {
            return Err("响应超过接收上限".into());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

pub(crate) async fn text(response: reqwest::Response, maximum: usize) -> Result<String, String> {
    let body = bytes(response, maximum).await?;
    // Match reqwest's text decoder for UTF-8 and BOM without losing a valid JSON tail.
    Ok(
        String::from_utf8_lossy(body.strip_prefix(&[0xef, 0xbb, 0xbf]).unwrap_or(&body))
            .into_owned(),
    )
}

pub(crate) async fn diagnostic(mut response: reqwest::Response) -> String {
    let mut body = Vec::new();
    while body.len() < DIAGNOSTIC_BYTES {
        match response.chunk().await {
            Ok(Some(chunk)) => {
                let n = chunk.len().min(DIAGNOSTIC_BYTES - body.len());
                body.extend_from_slice(&chunk[..n]);
            }
            _ => break,
        }
    }
    String::from_utf8_lossy(&body).into_owned()
}

pub(crate) async fn diagnostic_checked(
    response: reqwest::Response,
    checkpoint: impl Fn() -> Result<(), String>,
) -> Result<String, String> {
    let pending = diagnostic(response);
    tokio::pin!(pending);
    let mut tick = tokio::time::interval(std::time::Duration::from_millis(250));
    loop {
        tokio::select! {
            result = &mut pending => return Ok(result),
            _ = tick.tick() => checkpoint()?,
        }
    }
}

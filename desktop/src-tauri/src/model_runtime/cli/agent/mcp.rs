//! One Run's MCP transport; every business call still uses the native host callback.
use super::*;
use std::{
    io::{BufRead, BufReader},
    net::{SocketAddr, TcpListener, TcpStream},
    sync::atomic::{AtomicBool, Ordering},
    sync::Arc,
};
const LIMIT: usize = 524_288;
fn definitions(tools: &Value) -> Result<Value, String> {
    let tools = tools
        .as_array()
        .filter(|_| tools.to_string().len() <= 196_608)
        .ok_or("MCP工具清单无效或超限")?;
    Ok(json!(tools.iter().map(|t|json!({"name":t["name"],"description":t["description"],"inputSchema":t["inputSchema"]})).collect::<Vec<_>>()))
}
fn initialization(instructions: &str) -> Value {
    json!({"protocolVersion":crate::MCP_PROTOCOL_VERSION,"capabilities":{"tools":{"listChanged":false}},"serverInfo":{"name":"hub-work-run","version":env!("CARGO_PKG_VERSION")},"instructions":instructions})
}
pub(crate) fn startup_bytes(tools: &Value, instructions: &str) -> Result<usize, String> {
    let tools = definitions(tools)?;
    let id = "i".repeat(126); // Maximum accepted serialized request ID is128 bytes.
    let init = json!({"jsonrpc":"2.0","id":id,"result":initialization(instructions)});
    let list = json!({"jsonrpc":"2.0","id":id,"result":{"tools":tools}});
    Ok(init.to_string().len() + 1 + list.to_string().len() + 1 - tools.to_string().len())
}
struct Pending {
    request: Value,
    reply: mpsc::SyncSender<Result<Value, String>>,
}
pub(super) struct Bridge {
    address: String,
    secret: String,
    tools: Value,
    instructions: String,
    receiver: mpsc::Receiver<Pending>,
    stop: Arc<AtomicBool>,
    worker: Option<std::thread::JoinHandle<()>>,
    calls: HashMap<String, Value>,
    deliveries: HashMap<String, (String, usize, Value)>,
    enabled: bool,
}
fn line(
    reader: &mut impl BufRead,
    control: &Control,
    stop: &AtomicBool,
) -> Result<Option<Value>, String> {
    let mut bytes = Vec::new();
    loop {
        control.check()?;
        if stop.load(Ordering::Acquire) {
            return Err("MCP运行已关闭".into());
        }
        match (&mut *reader)
            .take((LIMIT + 1 - bytes.len()) as u64)
            .read_until(b'\n', &mut bytes)
        {
            Ok(0) => {
                return if bytes.is_empty() {
                    Ok(None)
                } else {
                    Err("MCP帧未完整结束".into())
                }
            }
            Ok(_) if bytes.len() > LIMIT => return Err("MCP帧超过容量".into()),
            Ok(_) if bytes.ends_with(b"\n") => {
                return serde_json::from_slice(&bytes)
                    .map(Some)
                    .map_err(|_| "MCP帧不是有效JSON".into())
            }
            Ok(_) => (),
            Err(e)
                if matches!(
                    e.kind(),
                    std::io::ErrorKind::TimedOut | std::io::ErrorKind::WouldBlock
                ) =>
            {
                ()
            }
            Err(_) => return Err("MCP通道读取失败".into()),
        }
    }
}
fn send(writer: &mut impl Write, value: &Value) -> Result<(), String> {
    let raw = value.to_string();
    if raw.len() > LIMIT {
        return Err("MCP响应超过容量".into());
    }
    writer
        .write_all(raw.as_bytes())
        .and_then(|_| writer.write_all(b"\n"))
        .and_then(|_| writer.flush())
        .map_err(|_| "MCP响应发送失败".into())
}
impl Drop for Bridge {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Bridge {
    pub(super) fn new(
        tools: &Value,
        instructions: &str,
        control: &Control,
    ) -> Result<Self, String> {
        let tools = definitions(tools)?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .map_err(|_| "无法建立本轮MCP通道")?;
        listener
            .set_nonblocking(true)
            .map_err(|_| "无法设置MCP通道")?;
        let address = listener
            .local_addr()
            .map_err(|_| "无法核对MCP地址")?
            .to_string();
        let secret = crate::random_url_safe(32);
        let (tx, receiver) = mpsc::sync_channel(1);
        let stop = Arc::new(AtomicBool::new(false));
        let halted = stop.clone();
        let authority = secret.clone();
        let control = control.clone();
        let worker = std::thread::spawn(move || {
            let result: Result<(), String> = (|| {
                let stream = loop {
                    control.check()?;
                    if halted.load(Ordering::Acquire) {
                        return Ok(());
                    }
                    match listener.accept() {
                        Ok((s, peer)) if peer.ip().is_loopback() => break s,
                        Ok(_) => return Err("MCP连接不是本机".into()),
                        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                            std::thread::sleep(Duration::from_millis(10))
                        }
                        Err(_) => return Err("MCP接收连接失败".into()),
                    }
                };
                stream
                    .set_read_timeout(Some(Duration::from_millis(100)))
                    .map_err(|_| "MCP超时设置失败")?;
                stream
                    .set_write_timeout(Some(Duration::from_secs(2)))
                    .map_err(|_| "MCP超时设置失败")?;
                let mut writer = stream.try_clone().map_err(|_| "MCP连接不可用")?;
                let mut reader = BufReader::new(stream);
                for _ in 0..512 {
                    let Some(packet) = line(&mut reader, &control, &halted)? else {
                        return Ok(());
                    };
                    if packet["secret"] != authority {
                        return Err("MCP本轮能力身份不匹配".into());
                    }
                    let (reply, receive) = mpsc::sync_channel(1);
                    tx.send(Pending {
                        request: packet["request"].clone(),
                        reply,
                    })
                    .map_err(|_| "MCP宿主已结束")?;
                    let response = loop {
                        control.check()?;
                        if halted.load(Ordering::Acquire) {
                            return Ok(());
                        }
                        match receive.recv_timeout(Duration::from_millis(100)) {
                            Ok(v) => break v?,
                            Err(mpsc::RecvTimeoutError::Timeout) => (),
                            Err(_) => return Err("MCP宿主已结束".into()),
                        }
                    };
                    send(&mut writer, &response)?;
                }
                Err("MCP本轮请求次数已用尽".into())
            })();
            if let Err(error) = result {
                let (reply, _) = mpsc::sync_channel(1);
                let _ = tx.try_send(Pending {
                    request: json!({"transportFailure":error}),
                    reply,
                });
            }
        });
        Ok(Self {
            address,
            secret,
            tools,
            instructions: instructions.into(),
            receiver,
            stop,
            worker: Some(worker),
            calls: HashMap::new(),
            deliveries: HashMap::new(),
            enabled: false,
        })
    }
    pub(super) fn config(&self) -> Result<Value, String> {
        #[cfg(test)]
        if let Some(value) = tests::peer_override(self)? {
            return Ok(value);
        }
        Ok(
            json!({"hub_run":{"command":std::env::current_exe().map_err(|_|"无法核对MCP程序")?,"args":["--agent-mcp"],"env":{"HUB_AGENT_MCP_ADDRESS":self.address,"HUB_AGENT_MCP_SECRET":self.secret},"enabled":true,"required":true,"startup_timeout_sec":20,"tool_timeout_sec":120,"default_tools_approval_mode":"approve"}}),
        )
    }
    pub(super) fn enable(&mut self) {
        self.enabled = true;
    }
    pub(super) fn drain(
        &mut self,
        control: &Control,
        host: &mut impl FnMut(&str, &Value) -> Result<Value, String>,
    ) -> Result<(), String> {
        let until = Instant::now() + Duration::from_secs(2);
        while !self.deliveries.is_empty() {
            control.check()?;
            if Instant::now() >= until {
                return Err("MCP工具发送回执尚未完整确认，已有结果保留".into());
            }
            self.poll(host)?;
            std::thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    }
    pub(super) fn poll(
        &mut self,
        host: &mut impl FnMut(&str, &Value) -> Result<Value, String>,
    ) -> Result<(), String> {
        for _ in 0..4 {
            let pending = match self.receiver.try_recv() {
                Ok(v) => v,
                Err(mpsc::TryRecvError::Empty) => break,
                Err(_) => return Err("MCP通道已结束，已有结果保留".into()),
            };
            if let Some(error) = pending.request["transportFailure"].as_str() {
                return Err(error.into());
            }
            let response = self.handle(&pending.request, host);
            let failure = response.as_ref().err().cloned();
            let _ = pending.reply.send(response);
            if let Some(error) = failure {
                return Err(error);
            }
        }
        Ok(())
    }
    fn handle(
        &mut self,
        request: &Value,
        host: &mut impl FnMut(&str, &Value) -> Result<Value, String>,
    ) -> Result<Value, String> {
        if request["jsonrpc"] != "2.0" {
            return Err("MCP版本无效".into());
        }
        let method = request["method"].as_str().ok_or("MCP方法缺失")?;
        if method == "notifications/hubResponseFlushed" {
            let p = &request["params"];
            let key = p["id"].to_string();
            let Some((digest, bytes, receipt)) = self.deliveries.get(&key) else {
                return Err("MCP发送回执没有对应结果".into());
            };
            if p["sha256"] != *digest || p["utf8Bytes"] != *bytes {
                return Err("MCP发送回执指纹不一致".into());
            }
            host("toolResponseSent", receipt)?;
            self.deliveries.remove(&key);
            return Ok(Value::Null);
        }
        if request.get("id").is_none() {
            return Ok(Value::Null);
        }
        let id = request["id"].clone();
        if !id.is_string() && !id.is_number() || id.to_string().len() > 128 {
            return Err("MCP请求身份无效".into());
        }
        let mut charged = 0;
        let result = match method {
            "initialize" => initialization(&self.instructions),
            "ping" => json!({}),
            "tools/list" => {
                charged = self.tools.to_string().len();
                json!({"tools":self.tools})
            }
            "tools/call" => {
                if !self.enabled {
                    return Err("MCP本轮模型尚未开始，不能执行工具".into());
                }
                let p = &request["params"];
                let name = p["name"].as_str().ok_or("MCP工具缺失")?;
                if !self
                    .tools
                    .as_array()
                    .unwrap()
                    .iter()
                    .any(|t| t["name"] == name)
                {
                    return Err("MCP工具不属于本轮授权清单".into());
                }
                let call = format!("mcp-{:x}", sha2::Sha256::digest(id.to_string().as_bytes()));
                let input = json!({"callId":call,"tool":name,"arguments":p["arguments"]});
                let value = super::tool_result(&input, &mut self.calls, host)?;
                charged = value.to_string().len();
                let receipt = json!({"callId":call,"outputSha256":format!("{:x}",sha2::Sha256::digest(value.to_string().as_bytes())),"outputUtf8Bytes":charged,"transport":"mcpStdio"});
                let result = json!({"content":[{"type":"text","text":value.to_string()}],"isError":value.get("error").is_some()});
                let response = json!({"jsonrpc":"2.0","id":id,"result":result});
                let wire = response.to_string();
                self.deliveries.insert(
                    id.to_string(),
                    (
                        format!("{:x}", sha2::Sha256::digest(wire.as_bytes())),
                        wire.len(),
                        receipt,
                    ),
                );
                host(
                    "transportBytes",
                    &json!({"transport":"mcpStdio","bytes":wire.len().saturating_add(1).saturating_sub(charged),"boundary":"JSON-RPC stdout envelope beyond the already charged exact tool result"}),
                )?;
                return Ok(response);
            }
            _ => {
                return Ok(
                    json!({"jsonrpc":"2.0","id":id,"error":{"code":-32601,"message":"本轮MCP只支持正式工具入口"}}),
                )
            }
        };
        let response = json!({"jsonrpc":"2.0","id":id,"result":result});
        host(
            "transportBytes",
            &json!({"transport":"mcpStdio","bytes":response.to_string().len().saturating_add(1).saturating_sub(charged),"instructionBytes":if method=="initialize"{self.instructions.len()}else{0},"boundary":"MCP setup/framing; tool definitions already in initial ledger, repeated instructions classified separately"}),
        )?;
        Ok(response)
    }
}

/// This child has no database or source access; its capability expires with the owning Run.
pub fn stdio() -> Result<(), String> {
    let address: SocketAddr = std::env::var("HUB_AGENT_MCP_ADDRESS")
        .map_err(|_| "缺少本轮MCP地址")?
        .parse()
        .map_err(|_| "MCP地址无效")?;
    let secret = std::env::var("HUB_AGENT_MCP_SECRET").map_err(|_| "缺少本轮MCP能力身份")?;
    if !address.ip().is_loopback() || secret.len() != 43 {
        return Err("本轮MCP能力无效".into());
    }
    let mut writer = TcpStream::connect_timeout(&address, Duration::from_secs(3))
        .map_err(|_| "本轮MCP通道已不可用")?;
    writer
        .set_read_timeout(Some(Duration::from_secs(120)))
        .map_err(|_| "MCP超时设置失败")?;
    writer
        .set_write_timeout(Some(Duration::from_secs(2)))
        .map_err(|_| "MCP超时设置失败")?;
    let mut reader = BufReader::new(writer.try_clone().map_err(|_| "MCP通道不可用")?);
    let stdin = std::io::stdin();
    let mut input = stdin.lock();
    let mut stdout = std::io::stdout().lock();
    let control = Control::bounded(Duration::from_secs(900));
    let stop = AtomicBool::new(false);
    while let Some(request) = line(&mut input, &control, &stop)? {
        send(&mut writer, &json!({"secret":secret,"request":request}))?;
        let response = line(&mut reader, &control, &stop)?.ok_or("MCP宿主已结束")?;
        if request.get("id").is_some() {
            send(&mut stdout, &response)?;
            if request["method"] == "tools/call" && response.get("result").is_some() {
                let raw = response.to_string();
                let receipt = json!({"jsonrpc":"2.0","method":"notifications/hubResponseFlushed","params":{"id":request["id"],"sha256":format!("{:x}",sha2::Sha256::digest(raw.as_bytes())),"utf8Bytes":raw.len()}});
                send(&mut writer, &json!({"secret":secret,"request":receipt}))?;
                let _ = line(&mut reader, &control, &stop)?.ok_or("MCP发送确认未返回")?;
            }
        }
    }
    Ok(())
}
#[cfg(test)]
mod tests;

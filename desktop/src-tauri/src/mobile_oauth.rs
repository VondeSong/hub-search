//! Register before opening the browser; release pending callbacks on cancellation or timeout.
use std::{
    collections::HashMap,
    sync::{Mutex, OnceLock},
};
use tokio::sync::oneshot;
use url::Url;

#[derive(Default)]
pub(crate) struct Callbacks(Mutex<HashMap<String, oneshot::Sender<Result<String, String>>>>);

pub(crate) struct Pending<'a> {
    owner: &'a Callbacks,
    state: String,
    receiver: oneshot::Receiver<Result<String, String>>,
}

pub(crate) fn callbacks() -> &'static Callbacks {
    static CALLBACKS: OnceLock<Callbacks> = OnceLock::new();
    CALLBACKS.get_or_init(Callbacks::default)
}

impl Callbacks {
    pub(crate) fn begin(&self, state: &str) -> Result<Pending<'_>, String> {
        let mut pending = self.0.lock().map_err(|_| "移动端 OAuth 回调状态不可用")?;
        if state.is_empty() || pending.contains_key(state) {
            return Err("移动端 OAuth 授权状态无效".into());
        }
        let (sender, receiver) = oneshot::channel();
        pending.insert(state.into(), sender);
        Ok(Pending {
            owner: self,
            state: state.into(),
            receiver,
        })
    }

    pub(crate) fn receive(&self, url: &Url) {
        if url.scheme() != "hub-craft-search"
            || url.host_str() != Some("oauth")
            || url.path() != "/callback"
        {
            return;
        }
        let mut values = HashMap::new();
        for (key, value) in url.query_pairs() {
            if values
                .insert(key.into_owned(), value.into_owned())
                .is_some()
            {
                return;
            }
        }
        let Some(state) = values.get("state") else {
            return;
        };
        let result = if let Some(error) = values.get("error") {
            Err(format!("资料库授权失败：{error}"))
        } else if let Some(code) = values.get("code").filter(|code| !code.is_empty()) {
            Ok(code.clone())
        } else {
            Err("OAuth 回调没有 authorization code".into())
        };
        if let Some(sender) = self
            .0
            .lock()
            .ok()
            .and_then(|mut pending| pending.remove(state))
        {
            let _ = sender.send(result);
        }
    }
}

impl Pending<'_> {
    pub(crate) async fn wait(&mut self) -> Result<String, String> {
        (&mut self.receiver)
            .await
            .map_err(|_| "移动端 OAuth 回调已取消")?
    }
}
impl Drop for Pending<'_> {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.owner.0.lock() {
            pending.remove(&self.state);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[tokio::test]
    async fn callback_can_arrive_before_waiting_and_is_consumed_once() {
        let callbacks = Callbacks::default();
        let mut pending = callbacks.begin("expected").unwrap();
        callbacks.receive(
            &Url::parse("hub-craft-search://oauth/callback?state=expected&code=first").unwrap(),
        );
        callbacks.receive(
            &Url::parse("hub-craft-search://oauth/callback?state=expected&code=second").unwrap(),
        );
        assert_eq!(pending.wait().await.unwrap(), "first");
        assert!(callbacks.0.lock().unwrap().is_empty());
    }
    #[tokio::test]
    async fn foreign_or_ambiguous_callbacks_do_not_consume_pending_login() {
        let callbacks = Callbacks::default();
        let mut pending = callbacks.begin("expected").unwrap();
        for url in [
            "https://oauth/callback?state=expected&code=x",
            "hub-craft-search://wrong/oauth/callback?state=expected&code=x",
            "hub-craft-search://oauth/callback?state=other&error=denied",
            "hub-craft-search://oauth/callback?state=expected&state=other&code=x",
        ] {
            callbacks.receive(&Url::parse(url).unwrap());
            assert!(matches!(
                pending.receiver.try_recv(),
                Err(oneshot::error::TryRecvError::Empty)
            ));
        }
        callbacks.receive(
            &Url::parse("hub-craft-search://oauth/callback?state=expected&error=access_denied")
                .unwrap(),
        );
        assert!(pending.wait().await.unwrap_err().contains("access_denied"));
    }
    #[tokio::test]
    async fn timeout_or_cancellation_releases_registration() {
        let callbacks = Callbacks::default();
        let mut pending = callbacks.begin("expected").unwrap();
        assert!(
            tokio::time::timeout(std::time::Duration::from_millis(1), pending.wait())
                .await
                .is_err()
        );
        drop(pending);
        assert!(callbacks.0.lock().unwrap().is_empty());
        assert!(callbacks.begin("expected").is_ok());
    }
}

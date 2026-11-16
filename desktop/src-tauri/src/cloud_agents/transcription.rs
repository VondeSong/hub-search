use super::*;

#[derive(Deserialize)]
#[serde(tag = "action", rename_all = "camelCase", deny_unknown_fields)]
pub(crate) enum Action {
    Providers,
    Start {
        job: String,
        provider: String,
        source: String,
    },
    Read {
        job: String,
    },
    Append {
        job: String,
        offset: u64,
        audio: String,
    },
    Finish {
        job: String,
        bytes: u64,
    },
    Cancel {
        job: String,
    },
    Replay {
        job: String,
        provider: String,
        hash: String,
    },
}

pub(super) async fn run(app: &AppHandle, config: &Config, action: Action) -> Result<Value, String> {
    let provider = |value: String| -> Result<String, String> {
        if matches!(value.as_str(), "aliyun" | "openai") {
            Ok(value)
        } else {
            Err("转写服务无效。".into())
        }
    };
    let path = |job: &str| -> Result<String, String> { Ok(format!("/v1/voice/jobs/{}", id(job)?)) };
    let (method, url, body) = match action {
        Action::Providers => (Method::GET, "/v1/voice/providers".to_string(), None),
        Action::Start {
            job,
            provider: selected,
            source,
        } => {
            if source.len() != 32
                || !source
                    .bytes()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase())
            {
                return Err("录音身份无效。".into());
            }
            (
                Method::POST,
                path(&job)?,
                Some(json!({"provider":provider(selected)?,"source":source})),
            )
        }
        Action::Read { job } => (Method::GET, path(&job)?, None),
        Action::Append { job, offset, audio } => {
            if audio.len() > 128000 || offset > 24_000 * 2 * 1800 {
                return Err("录音分段超出限制。".into());
            }
            (
                Method::POST,
                format!("{}/chunks", path(&job)?),
                Some(json!({"offset":offset,"audio":audio})),
            )
        }
        Action::Finish { job, bytes } => (
            Method::POST,
            format!("{}/finish", path(&job)?),
            Some(json!({"bytes":bytes})),
        ),
        Action::Cancel { job } => (
            Method::POST,
            format!("{}/cancel", path(&job)?),
            Some(json!({})),
        ),
        Action::Replay {
            job,
            provider: selected,
            hash,
        } => {
            let audio = crate::quick_journal::voice::transcription_audio(app, &hash)?;
            (
                Method::POST,
                path(&job)?,
                Some(
                    json!({"provider":provider(selected)?,"source":hash,"audio":STANDARD.encode(audio)}),
                ),
            )
        }
    };
    request(config, method, &url, body, false)
        .await
        .map_err(Into::into)
}

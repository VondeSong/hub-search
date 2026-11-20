//! Ask WebView2 about the DOM Files selected by the user. No path is opened here.
use std::path::Path;
use tauri::Manager;
use webview2_com::{
    take_pwstr, CoTaskMemPWSTR,
    Microsoft::Web::WebView2::Win32::{
        ICoreWebView2File, ICoreWebView2WebMessageReceivedEventArgs2,
    },
    WebMessageReceivedEventHandler,
};
use windows_core::Interface;

fn folders(path: &Path) -> Vec<String> {
    let home = std::env::var_os("USERPROFILE");
    let relative = home
        .as_deref()
        .and_then(|home| path.strip_prefix(home).ok())
        .unwrap_or(path);
    let mut names: Vec<_> = relative
        .parent()
        .into_iter()
        .flat_map(Path::ancestors)
        .map_while(Path::file_name)
        .take(2)
        .map(|name| name.to_string_lossy().into_owned())
        .collect();
    names.reverse();
    names
}

pub(crate) fn plugin() -> tauri::plugin::TauriPlugin<tauri::Wry> {
    tauri::plugin::Builder::new("attachment-folders")
        .on_webview_ready(|view: tauri::Webview| {
            if !matches!(view.label(), "main" | "quick-assistant") {
                return;
            }
            let dev_origin = view
                .config()
                .build
                .dev_url
                .as_ref()
                .filter(|_| cfg!(debug_assertions))
                .map(|url| url.origin());
            let _ = view.with_webview(move |webview| unsafe {
                let Ok(core) = webview.controller().CoreWebView2() else {
                    return;
                };
                let handler =
                    WebMessageReceivedEventHandler::create(Box::new(move |sender, args| {
                        let (Some(sender), Some(args)) = (sender, args) else {
                            return Ok(());
                        };
                        let Ok(extra) = args.cast::<ICoreWebView2WebMessageReceivedEventArgs2>()
                        else {
                            return Ok(());
                        };
                        let Ok(objects) = extra.AdditionalObjects() else {
                            return Ok(());
                        };
                        let mut count = 0;
                        objects.Count(&mut count)?;
                        if !(1..=8).contains(&count) {
                            return Ok(());
                        }
                        let mut message = Default::default();
                        args.TryGetWebMessageAsString(&mut message)?;
                        let message = take_pwstr(message);
                        let Some(id) = message.strip_prefix("hub-attachment-folders:") else {
                            return Ok(());
                        };
                        if id.len() != 36 || !id.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
                        {
                            return Ok(());
                        }
                        let mut source = Default::default();
                        args.Source(&mut source)?;
                        let Ok(url) = url::Url::parse(&take_pwstr(source)) else {
                            return Ok(());
                        };
                        let local = matches!(url.scheme(), "http" | "https")
                            && url.host_str() == Some("tauri.localhost")
                            && url.port().is_none();
                        if !local && dev_origin.as_ref() != Some(&url.origin()) {
                            return Ok(());
                        }
                        let mut hints = Vec::new();
                        for index in 0..count {
                            let file = objects
                                .GetValueAtIndex(index)
                                .and_then(|object| object.cast::<ICoreWebView2File>());
                            let hint = file
                                .and_then(|file| {
                                    let mut path = Default::default();
                                    file.Path(&mut path)?;
                                    Ok(folders(Path::new(&take_pwstr(path))))
                                })
                                .unwrap_or_default();
                            hints.push(hint);
                        }
                        let reply = serde_json::json!({"attachmentFoldersId":id,"folders":hints})
                            .to_string();
                        let reply = CoTaskMemPWSTR::from(reply.as_str());
                        sender.PostWebMessageAsJson(*reply.as_ref().as_pcwstr())
                    }));
                let mut token = 0;
                let _ = core.add_WebMessageReceived(&handler, &mut token);
            });
        })
        .build()
}

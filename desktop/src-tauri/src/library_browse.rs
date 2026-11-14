use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::Value;
use tauri::AppHandle;

use crate::{database_path, hidden_library_ids, open_database, parse_named_listing};

pub(crate) fn save_obsidian_folders(
    connection: &Connection,
    library_id: &str,
    folders: &[String],
) -> Result<(), String> {
    let value = serde_json::to_string(folders).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![format!("obsidian_browse_folders:{library_id}"), value],
    ).map_err(|error| format!("无法缓存 Obsidian 文件夹：{error}"))?;
    Ok(())
}

pub(crate) fn install_schema(connection: &Connection) -> Result<(), String> {
    let present: bool = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('folders') WHERE name='parent_id')",
            [],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !present {
        connection
            .execute("ALTER TABLE folders ADD COLUMN parent_id TEXT", [])
            .map_err(|error| format!("无法初始化资料库目录层级：{error}"))?;
    }
    Ok(())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct BrowseFolder {
    pub id: String,
    pub name: String,
    pub parent_id: Option<String>,
}

fn folder_line(line: &str) -> Option<(String, String)> {
    let line = line.trim_start();
    let line = line
        .strip_prefix("* ")
        .or_else(|| line.strip_prefix("- "))
        .unwrap_or(line);
    let (id, mut name) = parse_named_listing(line).pop()?;
    if let Some((title, count)) = name.rsplit_once(" (") {
        if let Some(number) = count
            .strip_suffix(" docs)")
            .or_else(|| count.strip_suffix(" documents)"))
        {
            if number.parse::<usize>().is_ok() {
                name = title.to_string();
            }
        }
    }
    Some((id, name))
}

pub(crate) fn craft_folders(
    value: Option<&Value>,
    text: &str,
) -> Result<Vec<BrowseFolder>, String> {
    fn collect(
        items: &[Value],
        parent: Option<&str>,
        folders: &mut Vec<BrowseFolder>,
    ) -> Result<(), String> {
        for item in items {
            let id = item
                .get("id")
                .and_then(Value::as_str)
                .filter(|id| {
                    !id.is_empty()
                        && id
                            .bytes()
                            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
                })
                .ok_or("Craft 文件夹没有有效 ID")?;
            let name = item
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| !name.trim().is_empty())
                .ok_or("Craft 文件夹没有有效名称")?;
            folders.push(BrowseFolder {
                id: id.to_string(),
                name: name.to_string(),
                parent_id: parent
                    .or_else(|| item.get("parentId").and_then(Value::as_str))
                    .filter(|parent| !parent.is_empty())
                    .map(str::to_string),
            });
            if let Some(children) = item.get("children").or_else(|| item.get("folders")) {
                if !children.is_null() {
                    collect(
                        children.as_array().ok_or("Craft 子文件夹格式无效")?,
                        Some(id),
                        folders,
                    )?;
                }
            }
        }
        Ok(())
    }
    let mut folders = Vec::new();
    if let Some(items) = value.and_then(|value| {
        value.as_array().or_else(|| {
            value
                .get("items")
                .or_else(|| value.get("folders"))
                .and_then(Value::as_array)
        })
    }) {
        collect(items, None, &mut folders)?;
    } else {
        let mut path: Vec<(usize, String)> = Vec::new();
        for line in text.lines() {
            let Some((id, name)) = folder_line(line) else {
                continue;
            };
            let indentation = line.len() - line.trim_start().len();
            while path.last().is_some_and(|(depth, _)| *depth >= indentation) {
                path.pop();
            }
            let parent_id = path.last().map(|(_, id)| id.clone());
            path.push((indentation, id.clone()));
            folders.push(BrowseFolder {
                id,
                name,
                parent_id,
            });
        }
        if folders.is_empty() && !text.contains("No folders") && !text.contains("0 folders") {
            return Err("无法确认 Craft 文件夹清单，已保留上次同步的目录".into());
        }
    }
    validate_craft_folders(&folders)?;
    Ok(folders)
}

pub(crate) fn validate_craft_folders(folders: &[BrowseFolder]) -> Result<(), String> {
    let parents = folders
        .iter()
        .map(|folder| (folder.id.as_str(), folder.parent_id.as_deref()))
        .collect::<HashMap<_, _>>();
    if parents.len() != folders.len() {
        return Err("Craft 文件夹清单包含重复 ID".into());
    }
    for folder in folders {
        let mut seen = HashSet::from([folder.id.as_str()]);
        let mut parent = folder.parent_id.as_deref();
        while let Some(id) = parent {
            if !seen.insert(id) {
                return Err("Craft 文件夹清单包含循环关系".into());
            }
            parent = parents.get(id).copied().flatten();
        }
    }
    Ok(())
}

pub(crate) fn has_craft_ancestor(
    parents: &HashMap<&str, Option<&str>>,
    folder: &str,
    ancestor: &str,
) -> bool {
    let mut current = parents.get(folder).copied().flatten();
    while let Some(id) = current {
        if id == ancestor {
            return true;
        }
        current = parents.get(id).copied().flatten();
    }
    false
}

pub(crate) fn resolve_craft_location(
    parents: &HashMap<&str, Option<&str>>,
    locations: &[String],
) -> Option<String> {
    locations
        .iter()
        .find(|candidate| {
            locations
                .iter()
                .all(|other| *candidate == other || has_craft_ancestor(parents, candidate, other))
        })
        .cloned()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseDocument {
    id: String,
    title: String,
    path: String,
    folder_id: Option<String>,
    modified_at: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryContents {
    folders: Vec<BrowseFolder>,
    documents: Vec<BrowseDocument>,
    craft_locations_synced: bool,
}

#[tauri::command]
pub(crate) async fn library_contents(
    app: AppHandle,
    library_id: String,
) -> Result<LibraryContents, String> {
    let path = database_path(&app)?;
    tokio::task::spawn_blocking(move || {
        let connection = open_database(&path)?;
        let transaction = connection
            .unchecked_transaction()
            .map_err(|error| error.to_string())?;
        if hidden_library_ids(&path, &transaction)?.contains(&library_id) {
            return Err("资料库已移除或停用".into());
        }
        read_contents(&transaction, &library_id)
    })
    .await
    .map_err(|error| format!("读取资料库任务失败：{error}"))?
}

fn read_contents(connection: &Connection, library_id: &str) -> Result<LibraryContents, String> {
    let provider: String = connection.query_row(
        "SELECT provider FROM libraries WHERE id=?1 AND enabled=1 AND provider IN ('craft','obsidian')",
        [library_id],
        |row| row.get(0),
    ).map_err(|_| "此资料库不可浏览")?;
    let mut folder_query = connection.prepare(
        "SELECT id, name, path, parent_id FROM folders WHERE space_id=?1 ORDER BY lower(name), id",
    ).map_err(|error| error.to_string())?;
    let folder_rows = folder_query
        .query_map([library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut folders = Vec::new();
    let mut paths = HashSet::new();
    for row in folder_rows {
        let (id, name, path, parent_id) = row.map_err(|error| error.to_string())?;
        if provider == "craft" {
            folders.push(BrowseFolder {
                id,
                name,
                parent_id,
            });
        } else {
            for (position, _) in path.match_indices('/') {
                paths.insert(path[..position].to_string());
            }
            if !path.is_empty() {
                paths.insert(path);
            }
        }
    }
    let mut document_query = connection
        .prepare(
            "SELECT id, title, path, folder_id, modified_at FROM documents
         WHERE space_id=?1 AND provider=?2 ORDER BY lower(title), id",
        )
        .map_err(|error| error.to_string())?;
    let documents = document_query
        .query_map(params![library_id, provider], |row| {
            Ok(BrowseDocument {
                id: row.get(0)?,
                title: row.get(1)?,
                path: row.get(2)?,
                folder_id: row.get(3)?,
                modified_at: row.get(4)?,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    if provider == "obsidian" {
        let excluded = crate::library_excluded_paths(connection, library_id)?;
        let snapshot = connection.query_row(
            "SELECT value FROM metadata WHERE key=?1",
            [format!("obsidian_browse_folders:{library_id}")],
            |row| row.get::<_, String>(0),
        );
        match snapshot {
            Ok(value) => {
                let saved = serde_json::from_str::<Vec<String>>(&value)
                    .map_err(|error| error.to_string())?;
                paths.extend(saved);
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => {}
            Err(error) => return Err(error.to_string()),
        }
        paths.retain(|path| !crate::sources::obsidian_path_is_excluded(path, &excluded));
        for path in paths {
            let (parent, name) = path
                .rsplit_once('/')
                .map_or((None, path.as_str()), |(parent, name)| (Some(parent), name));
            folders.push(BrowseFolder {
                id: crate::obsidian_folder_id(library_id, &path),
                name: name.to_string(),
                parent_id: parent.map(|parent| crate::obsidian_folder_id(library_id, parent)),
            });
        }
    }
    let craft_locations_synced = provider == "craft"
        && crate::metadata_u64(
            connection,
            &format!("craft_browse_locations:{library_id}"),
            0,
        ) != 0;
    Ok(LibraryContents {
        folders,
        documents,
        craft_locations_synced,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn craft_folder_inventory_preserves_identity_and_rejects_bad_snapshots() {
        let folders = craft_folders(
            None,
            "* <a> 同名 (1 docs)\n  * <b> 同名 (0 docs)\n* <c> 同名",
        )
        .unwrap();
        assert_eq!(folders[0].name, "同名");
        assert_eq!(folders[1].parent_id.as_deref(), Some("a"));
        assert_eq!(folders[2].parent_id, None);
        let nested = json!({"items": [{"id":"a","name":"父","children":[{"id":"b","name":"子"}]}]});
        assert_eq!(
            craft_folders(Some(&nested), "").unwrap()[1]
                .parent_id
                .as_deref(),
            Some("a")
        );
        assert!(craft_folders(None, "Result truncated").is_err());
        assert!(craft_folders(None, "<a> 父\n  <a> 子").is_err());
        assert!(craft_folders(
            Some(&json!({"items":[{"id":"a","name":"父","parentId":"a"}]})),
            ""
        )
        .is_err());
    }

    #[test]
    fn recursive_craft_listings_choose_the_deepest_proven_location() {
        let parents = HashMap::from([
            ("parent", None),
            ("child", Some("parent")),
            ("outside", None),
        ]);
        let locate = |ids: &[&str]| {
            resolve_craft_location(
                &parents,
                &ids.iter().map(|id| id.to_string()).collect::<Vec<_>>(),
            )
        };
        assert_eq!(locate(&["parent", "child"]).as_deref(), Some("child"));
        assert_eq!(locate(&["child", "parent"]).as_deref(), Some("child"));
        assert_eq!(locate(&["parent", "outside"]), None);
    }

    #[test]
    fn obsidian_cached_tree_preserves_empty_and_attachment_only_folders() {
        let scratch =
            std::env::temp_dir().join(format!("hub-library-browse-{}", crate::random_url_safe(12)));
        let vault = scratch.join("vault");
        for name in ["项目/验收", "空目录", "图片", ".obsidian", "忽略"] {
            std::fs::create_dir_all(vault.join(name)).unwrap();
        }
        std::fs::write(vault.join("项目/验收/记录.md"), "# 记录").unwrap();
        std::fs::write(vault.join("图片/样例.png"), b"sample").unwrap();
        let connection =
            crate::database::initialize_database(&scratch.join("library.sqlite")).unwrap();
        connection.execute("INSERT INTO libraries (id,provider,name,added_at) VALUES ('vault','obsidian','测试库',0)", []).unwrap();
        let (_, dirs) =
            crate::sources::scan_obsidian_vault_with_folders(&vault, &["忽略".into()], &|| Ok(()))
                .unwrap();
        save_obsidian_folders(&connection, "vault", &dirs).unwrap();
        let contents = read_contents(&connection, "vault").unwrap();
        let names = contents
            .folders
            .iter()
            .map(|folder| folder.name.as_str())
            .collect::<HashSet<_>>();
        assert_eq!(names, HashSet::from(["项目", "验收", "空目录", "图片"]));
        assert_eq!(
            contents
                .folders
                .iter()
                .find(|folder| folder.name == "验收")
                .unwrap()
                .parent_id
                .as_deref(),
            Some(crate::obsidian_folder_id("vault", "项目").as_str())
        );
        drop(connection);
        std::fs::remove_dir_all(&scratch).unwrap();
    }
}

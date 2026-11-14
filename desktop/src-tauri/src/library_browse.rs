use std::collections::{HashMap, HashSet};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::AppHandle;

use crate::{
    database_path, hidden_library_ids, is_dida_default_column_name, open_database,
    parse_named_listing,
};

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

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct BrowseDocument {
    id: String,
    title: String,
    path: String,
    folder_id: Option<String>,
    modified_at: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    content_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    node_id: Option<String>,
}

#[derive(Deserialize, Serialize)]
pub(crate) struct FeishuBrowseNode {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub object_id: String,
    pub document_ids: Vec<String>,
}

fn feishu_key(library_id: &str) -> String {
    format!("feishu_browse_nodes:{library_id}")
}

pub(crate) fn save_feishu_nodes(
    connection: &Connection,
    library_id: &str,
    mut nodes: Vec<FeishuBrowseNode>,
) -> Result<(), String> {
    let tree = nodes
        .iter()
        .map(|node| (node.id.as_str(), node.parent_id.as_deref()))
        .collect::<HashMap<_, _>>();
    if tree.len() != nodes.len() {
        return Err("飞书目录节点重复，已保留原目录".into());
    }
    for id in tree.keys() {
        let mut seen = HashSet::from([*id]);
        let mut parent = tree[id];
        while let Some(id) = parent {
            if !seen.insert(id) || !tree.contains_key(id) {
                return Err("飞书目录节点存在循环或缺少父节点，已保留原目录".into());
            }
            parent = tree[id];
        }
    }
    // Keep the last usable preview mapping when a known object could not be fetched this time.
    let previous = read_feishu_nodes(connection, library_id)?.unwrap_or_default();
    let previous = previous
        .iter()
        .map(|node| (node.id.as_str(), node))
        .collect::<HashMap<_, _>>();
    for node in &mut nodes {
        if node.document_ids.is_empty() {
            if let Some(old) = previous
                .get(node.id.as_str())
                .filter(|old| old.object_id == node.object_id)
            {
                node.document_ids.clone_from(&old.document_ids);
            }
        }
    }
    let value = serde_json::to_string(&nodes).map_err(|error| error.to_string())?;
    connection.execute(
        "INSERT INTO metadata(key,value) VALUES(?1,?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![feishu_key(library_id), value],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn read_feishu_nodes(
    connection: &Connection,
    library_id: &str,
) -> Result<Option<Vec<FeishuBrowseNode>>, String> {
    match connection.query_row(
        "SELECT value FROM metadata WHERE key=?1",
        [feishu_key(library_id)],
        |row| row.get::<_, String>(0),
    ) {
        Ok(value) => serde_json::from_str(&value)
            .map(Some)
            .map_err(|error| error.to_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn feishu_contents(
    nodes: Vec<FeishuBrowseNode>,
    documents: Vec<BrowseDocument>,
) -> (Vec<BrowseFolder>, Vec<BrowseDocument>) {
    let parents = nodes
        .iter()
        .filter_map(|node| node.parent_id.as_deref())
        .collect::<HashSet<_>>();
    let by_id = documents
        .iter()
        .map(|document| (document.id.as_str(), document))
        .collect::<HashMap<_, _>>();
    let mut folders = Vec::new();
    let mut pages = Vec::new();
    for node in &nodes {
        let previews = node
            .document_ids
            .iter()
            .filter_map(|id| by_id.get(id.as_str()))
            .copied()
            .collect::<Vec<_>>();
        let is_folder = parents.contains(node.id.as_str()) || previews.len() != 1;
        if is_folder {
            folders.push(BrowseFolder {
                id: node.id.clone(),
                name: node.title.clone(),
                parent_id: node.parent_id.clone(),
            });
        }
        for preview in previews {
            let mut document = preview.clone();
            document.node_id = Some(node.id.clone());
            document.folder_id = if is_folder {
                Some(node.id.clone())
            } else {
                node.parent_id.clone()
            };
            if document.content_type.is_none() {
                document.title = node.title.clone();
            }
            pages.push(document);
        }
    }
    (folders, pages)
}

fn dida_contents(
    connection: &Connection,
    library_id: &str,
    documents: Vec<BrowseDocument>,
) -> Result<(Vec<BrowseFolder>, Vec<BrowseDocument>), String> {
    let mut folders = connection.prepare(
        "SELECT project_id,name FROM dida_projects WHERE library_id=?1 AND closed=0 ORDER BY sort_order,project_id",
    ).and_then(|mut statement| {
        statement.query_map([library_id], |row| {
            Ok(BrowseFolder { id: row.get(0)?, name: row.get(1)?, parent_id: None })
        })?.collect::<Result<Vec<_>, _>>()
    }).map_err(|error| error.to_string())?;
    let projects = folders
        .iter()
        .map(|folder| folder.id.clone())
        .collect::<HashSet<_>>();
    let mut statement = connection
        .prepare(
            "SELECT task_id,project_id,parent_id,column_id,column_name
         FROM dida_tasks WHERE library_id=?1 ORDER BY last_seen_at DESC,task_id",
        )
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([library_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Option<String>>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(|error| error.to_string())?;
    let mut metadata = HashMap::new();
    let mut groups = HashMap::new();
    for row in rows {
        let (id, project, parent, column, name) = row.map_err(|error| error.to_string())?;
        if !projects.contains(&project) {
            continue;
        }
        if let (Some(column), Some(name)) = (&column, name) {
            if !column.is_empty() && !name.trim().is_empty() && !is_dida_default_column_name(&name)
            {
                groups
                    .entry((project.clone(), column.clone()))
                    .or_insert(name);
            }
        }
        metadata.insert(id, (project, parent, column));
    }
    let group_id =
        |project: &str, column: &str| format!("dida-group:{}:{project}:{column}", project.len());
    let task_id = |task: &str| format!("dida-parent:{task}");
    folders.extend(groups.iter().map(|((project, column), name)| BrowseFolder {
        id: group_id(project, column),
        name: name.clone(),
        parent_id: Some(project.clone()),
    }));
    let indexed = documents
        .iter()
        .map(|document| document.id.as_str())
        .collect::<HashSet<_>>();
    let parent_of = |id: &str| {
        let (project, parent, _) = metadata.get(id)?;
        let parent = parent.as_deref()?;
        (indexed.contains(parent)
            && metadata
                .get(parent)
                .is_some_and(|(owner, _, _)| owner == project))
        .then_some(parent)
    };
    let mut parents = HashMap::new();
    for id in metadata.keys() {
        let mut seen = HashSet::from([id.as_str()]);
        let mut ancestor = parent_of(id);
        while let Some(node) = ancestor {
            if !seen.insert(node) {
                break;
            }
            ancestor = parent_of(node);
        }
        if ancestor.is_none() {
            if let Some(parent) = parent_of(id) {
                parents.insert(id.clone(), parent.to_string());
            }
        }
    }
    let with_children = parents.values().collect::<HashSet<_>>();
    let mut pages = Vec::new();
    for mut document in documents {
        let Some((project, _, column)) = metadata.get(&document.id) else {
            continue;
        };
        let parent = parents
            .get(&document.id)
            .map(|parent| task_id(parent))
            .unwrap_or_else(|| {
                column
                    .as_ref()
                    .filter(|column| groups.contains_key(&(project.clone(), (*column).clone())))
                    .map_or_else(|| project.clone(), |column| group_id(project, column))
            });
        document.folder_id = Some(if with_children.contains(&document.id) {
            let id = task_id(&document.id);
            folders.push(BrowseFolder {
                id: id.clone(),
                name: document.title.clone(),
                parent_id: Some(parent),
            });
            id
        } else {
            parent
        });
        pages.push(document);
    }
    Ok((folders, pages))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LibraryContents {
    folders: Vec<BrowseFolder>,
    documents: Vec<BrowseDocument>,
    craft_locations_synced: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    notice: Option<&'static str>,
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
        "SELECT provider FROM libraries WHERE id=?1 AND enabled=1 AND provider IN ('craft','obsidian','feishu','dida365')",
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
        } else if provider == "obsidian" {
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
            "SELECT id, title, path, folder_id, modified_at,
                    CASE WHEN ?2='feishu' AND id LIKE 'bitable-table:%' THEN 'feishu_bitable_table' END
             FROM documents WHERE space_id=?1 AND provider=?2 ORDER BY lower(title), id",
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
                content_type: row.get(5)?,
                node_id: None,
            })
        })
        .map_err(|error| error.to_string())?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let mut documents = documents;
    let mut notice = None;
    if provider == "feishu" {
        if let Some(nodes) = read_feishu_nodes(connection, library_id)? {
            (folders, documents) = feishu_contents(nodes, documents);
        } else {
            for document in &mut documents {
                document.folder_id = None;
            }
            notice = Some("当前显示已缓存的文档。知识空间同步后可浏览 Wiki 目录。");
        }
    } else if provider == "dida365" {
        (folders, documents) = dida_contents(connection, library_id, documents)?;
        notice = Some("显示已同步的清单、分组和子任务。");
    } else if provider == "obsidian" {
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
        notice,
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

    #[test]
    fn feishu_wiki_keeps_aliases_distinct_and_preserves_cached_previews() {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE metadata(key TEXT PRIMARY KEY,value TEXT)")
            .unwrap();
        let node = |id: &str, parent: Option<&str>, ids: Vec<String>| FeishuBrowseNode {
            id: id.into(),
            parent_id: parent.map(str::to_string),
            title: id.into(),
            object_id: "object".into(),
            document_ids: ids,
        };
        save_feishu_nodes(
            &connection,
            "wiki",
            vec![
                node("root", None, vec![]),
                node("alias-a", Some("root"), vec!["doc".into()]),
                node("alias-b", None, vec!["doc".into()]),
            ],
        )
        .unwrap();
        assert!(save_feishu_nodes(
            &connection,
            "wiki",
            vec![node("root", Some("root"), vec![])]
        )
        .is_err());
        save_feishu_nodes(
            &connection,
            "wiki",
            vec![
                node("root", None, vec![]),
                node("alias-a", Some("root"), vec![]),
                node("alias-b", None, vec![]),
            ],
        )
        .unwrap();
        let (folders, pages) = feishu_contents(
            read_feishu_nodes(&connection, "wiki").unwrap().unwrap(),
            vec![test_document("doc")],
        );
        assert_eq!(
            folders
                .iter()
                .map(|folder| folder.id.as_str())
                .collect::<Vec<_>>(),
            vec!["root"]
        );
        assert_eq!(
            pages
                .iter()
                .map(|page| (
                    page.id.as_str(),
                    page.node_id.as_deref(),
                    page.folder_id.as_deref()
                ))
                .collect::<Vec<_>>(),
            vec![
                ("doc", Some("alias-a"), Some("root")),
                ("doc", Some("alias-b"), None)
            ]
        );
    }

    #[test]
    fn dida_projects_show_groups_parent_tasks_children_and_empty_lists() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("
            CREATE TABLE dida_projects(library_id,project_id,name,closed,sort_order);
            CREATE TABLE dida_tasks(library_id,task_id,project_id,parent_id,column_id,column_name,last_seen_at);
            INSERT INTO dida_projects VALUES ('dida','list','List',0,0),('dida','empty','Empty',0,1),('dida','closed','Closed',1,2);
            INSERT INTO dida_tasks VALUES
              ('dida','parent','list',NULL,'todo','To Do',1),
              ('dida','child','list','parent',NULL,NULL,1),
              ('dida','default','list',NULL,'default','未分组',1),
              ('dida','closed-task','closed',NULL,NULL,NULL,1);
        ").unwrap();
        let (folders, pages) = dida_contents(
            &connection,
            "dida",
            ["parent", "child", "default", "closed-task"]
                .map(test_document)
                .to_vec(),
        )
        .unwrap();
        let group = folders
            .iter()
            .find(|folder| folder.name == "To Do")
            .unwrap();
        assert_eq!(group.parent_id.as_deref(), Some("list"));
        assert!(folders.iter().any(|folder| folder.id == "empty"));
        assert!(!folders
            .iter()
            .any(|folder| folder.id == "closed" || folder.name == "未分组"));
        assert_eq!(
            folders
                .iter()
                .find(|folder| folder.id == "dida-parent:parent")
                .unwrap()
                .parent_id
                .as_deref(),
            Some(group.id.as_str())
        );
        assert_eq!(
            pages
                .iter()
                .map(|page| (page.id.as_str(), page.folder_id.as_deref()))
                .collect::<Vec<_>>(),
            vec![
                ("parent", Some("dida-parent:parent")),
                ("child", Some("dida-parent:parent")),
                ("default", Some("list"))
            ]
        );
    }

    fn test_document(id: &str) -> BrowseDocument {
        BrowseDocument {
            id: id.into(),
            title: id.into(),
            path: String::new(),
            folder_id: None,
            modified_at: None,
            content_type: None,
            node_id: None,
        }
    }
}

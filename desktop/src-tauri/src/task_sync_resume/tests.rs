use super::*;

struct Database(PathBuf);
impl Database {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("hub-task-resume-{}", random_url_safe(12)));
        std::fs::create_dir(&root).unwrap();
        let path = root.join("test.sqlite3");
        let c = open_database(&path).unwrap();
        c.execute_batch(
            "INSERT INTO libraries(id,provider,name,enabled,added_at)
               VALUES ('craft','craft','Main',1,1),('other','craft','Car',1,1),('dida','dida365','滴答',1,1);
             INSERT INTO documents(space_id,id,title,path,markdown,indexed_at,content_hash,provider)
               VALUES ('craft','root','根文档','AI','',1,'root-hash','craft');
             INSERT INTO content_items(id,space_id,document_id,block_id,content_type,heading,body,ordinal,source_hash,provider,page_id,page_title)
               VALUES ('page-content','craft','root','section','markdown','待办事项','正文',0,'body-hash','craft','PAGE-HUB','Hub #项目');
             INSERT INTO craft_task_blocks(space_id,document_id,block_id,parent_page_id,title,completed,depth,source_hash,parent_task_id)
               VALUES ('craft','root','CHILD','PAGE-HUB','现有子任务',0,0,'child-hash','');
             INSERT INTO task_sync_exclusions(provider,library_id,source_id,delete_dida,reason,created_at)
               VALUES ('craft','craft','craft-project-page:page-hub',1,'用户选择保留 Craft，并从滴答移除',1),
                      ('craft','craft','child',0,'用户解除双向关联',2),
                      ('craft','other','craft-project-page:page-hub',1,'另一个资料库',3);
             INSERT INTO dida_tasks(library_id,task_id,project_id,title,raw_json,last_seen_at)
               VALUES ('dida','bound-child','custom-list','现有子任务','{\"id\":\"bound-child\",\"projectId\":\"custom-list\"}',1);
             INSERT INTO unified_task_bindings(hub_task_id,provider,library_id,source_id,document_id,source_hash,last_seen_at)
               VALUES ('child-hub','craft','craft','CHILD','root','child-hash',1),
                      ('child-hub','dida365','dida','bound-child','','child-hash',1);",
        ).unwrap();
        Self(path)
    }
}
impl Drop for Database {
    fn drop(&mut self) {
        forget_initialized_database(&self.0);
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("sqlite3-wal"));
        let _ = std::fs::remove_file(self.0.with_extension("sqlite3-shm"));
        let _ = std::fs::remove_dir(self.0.parent().unwrap());
    }
}

#[test]
fn resume_removes_only_reviewed_project_exclusion_and_keeps_child_placement_and_binding() {
    let database = Database::new();
    let c = open_database(&database.0).unwrap();
    let before: String = c
        .query_row(
            "SELECT raw_json FROM dida_tasks WHERE task_id='bound-child'",
            [],
            |r| r.get(0),
        )
        .unwrap();
    let message = resume_database(&database.0, "craft", " craft-project-page:PAGE-HUB ").unwrap();
    assert!(message.contains("收件箱"));
    assert!(message.contains("所在清单会保留"));
    let remaining = load_task_sync_exclusions(&database.0).unwrap();
    assert!(!task_sync_source_is_excluded(
        &remaining,
        PROVIDER_CRAFT,
        "craft",
        "craft-project-page:PAGE-HUB"
    ));
    assert!(task_sync_source_is_excluded(
        &remaining,
        PROVIDER_CRAFT,
        "craft",
        "CHILD"
    ));
    assert!(task_sync_source_is_excluded(
        &remaining,
        PROVIDER_CRAFT,
        "other",
        "craft-project-page:PAGE-HUB"
    ));
    let (project, raw): (String, String) = c
        .query_row(
            "SELECT project_id,raw_json FROM dida_tasks WHERE task_id='bound-child'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap();
    assert_eq!(project, "custom-list");
    assert_eq!(raw, before);
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM unified_task_bindings WHERE hub_task_id='child-hub'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        2
    );
    assert_eq!(c.query_row("SELECT COUNT(*) FROM task_sync_events WHERE action='resume_export' AND status='resolved'", [], |r|r.get::<_,i64>(0)).unwrap(), 1);
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM dida_tasks", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
}

#[test]
fn resume_is_idempotent_without_duplicate_audit_or_new_bindings() {
    let database = Database::new();
    resume_database(&database.0, "craft", "craft-project-page:PAGE-HUB").unwrap();
    let again = resume_database(&database.0, "craft", "CRAFT-PROJECT-PAGE:page-hub").unwrap();
    assert!(again.contains("已经允许"));
    let c = open_database(&database.0).unwrap();
    assert_eq!(
        c.query_row(
            "SELECT COUNT(*) FROM task_sync_events WHERE action='resume_export'",
            [],
            |r| r.get::<_, i64>(0)
        )
        .unwrap(),
        1
    );
    assert_eq!(
        c.query_row("SELECT COUNT(*) FROM unified_task_bindings", [], |r| r
            .get::<_, i64>(0))
            .unwrap(),
        2
    );
}

#[test]
fn resume_cannot_cancel_other_library_or_a_missing_source_exclusion() {
    let database = Database::new();
    assert!(resume_database(&database.0, "other", "craft-project-page:PAGE-HUB").is_err());
    assert!(resume_database(&database.0, "craft", "missing").is_err());
    assert_eq!(load_task_sync_exclusions(&database.0).unwrap().len(), 3);
}

#[test]
fn resume_requires_an_enabled_source_and_a_project_with_its_trigger_tag() {
    let database = Database::new();
    let c = open_database(&database.0).unwrap();
    c.execute(
        "UPDATE content_items SET page_title='Hub' WHERE page_id='PAGE-HUB'",
        [],
    )
    .unwrap();
    assert!(resume_database(&database.0, "craft", "craft-project-page:PAGE-HUB").is_err());
    c.execute("UPDATE libraries SET enabled=0 WHERE id='craft'", [])
        .unwrap();
    assert!(resume_database(&database.0, "craft", "CHILD").is_err());
    assert_eq!(load_task_sync_exclusions(&database.0).unwrap().len(), 3);
}

#[test]
fn resume_does_not_override_an_excluded_real_task_ancestor() {
    let database = Database::new();
    let c = open_database(&database.0).unwrap();
    c.execute_batch("INSERT INTO craft_task_blocks(space_id,document_id,block_id,parent_page_id,title,completed,depth,source_hash,parent_task_id) VALUES ('craft','root','GRANDCHILD','PAGE-HUB','孙任务',0,1,'grandchild-hash','CHILD'); INSERT INTO task_sync_exclusions(provider,library_id,source_id,delete_dida,reason,created_at) VALUES ('craft','craft','grandchild',0,'停止关联',1);").unwrap();
    assert!(resume_database(&database.0, "craft", "GRANDCHILD")
        .unwrap_err()
        .contains("上级"));
    let records = load_task_sync_records(&database.0).unwrap();
    let child = records
        .iter()
        .find(|r| r.source_id == "GRANDCHILD")
        .unwrap();
    let exclusions = load_task_sync_exclusions(&database.0).unwrap();
    assert!(task_sync_source_or_ancestor_is_excluded(
        &records,
        &exclusions,
        child
    ));
    assert!(task_sync_source_is_excluded(
        &exclusions,
        PROVIDER_CRAFT,
        "craft",
        "GRANDCHILD"
    ));
}

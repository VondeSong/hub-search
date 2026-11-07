//! Transactional live-job counts for frequent status consumers.
//! Queue rows and history remain authoritative; no count is computed by loading payloads.
use rusqlite::{params, Connection};

pub(crate) fn schema(c: &Connection) -> Result<(), String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let existed:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='index_job_live_counts')",[],|r|r.get(0)).map_err(|e|e.to_string())?;
    tx.execute_batch("CREATE TABLE IF NOT EXISTS index_job_live_counts(
        space_id TEXT NOT NULL,job_type TEXT NOT NULL,status TEXT NOT NULL,
        jobs INTEGER NOT NULL CHECK(jobs>=0),PRIMARY KEY(space_id,job_type,status));
      CREATE TRIGGER IF NOT EXISTS index_job_count_inserted AFTER INSERT ON index_jobs
      WHEN NEW.status IN ('pending','running','failed')
      BEGIN INSERT INTO index_job_live_counts(space_id,job_type,status,jobs) VALUES(NEW.space_id,NEW.job_type,NEW.status,1)
        ON CONFLICT(space_id,job_type,status) DO UPDATE SET jobs=jobs+1; END;
      CREATE TRIGGER IF NOT EXISTS index_job_count_deleted AFTER DELETE ON index_jobs
      WHEN OLD.status IN ('pending','running','failed')
      BEGIN UPDATE index_job_live_counts SET jobs=jobs-1 WHERE space_id=OLD.space_id AND job_type=OLD.job_type AND status=OLD.status;
        DELETE FROM index_job_live_counts WHERE space_id=OLD.space_id AND job_type=OLD.job_type AND status=OLD.status AND jobs=0; END;
      CREATE TRIGGER IF NOT EXISTS index_job_count_changed AFTER UPDATE OF space_id,job_type,status ON index_jobs
      WHEN OLD.space_id IS NOT NEW.space_id OR OLD.job_type IS NOT NEW.job_type OR OLD.status IS NOT NEW.status
      BEGIN UPDATE index_job_live_counts SET jobs=jobs-1 WHERE space_id=OLD.space_id AND job_type=OLD.job_type AND status=OLD.status;
        DELETE FROM index_job_live_counts WHERE space_id=OLD.space_id AND job_type=OLD.job_type AND status=OLD.status AND jobs=0;
        INSERT INTO index_job_live_counts(space_id,job_type,status,jobs)
          SELECT NEW.space_id,NEW.job_type,NEW.status,1 WHERE NEW.status IN ('pending','running','failed')
          ON CONFLICT(space_id,job_type,status) DO UPDATE SET jobs=jobs+1; END;
      CREATE INDEX IF NOT EXISTS index_jobs_library_latest ON index_jobs(space_id,updated_at DESC,id DESC);
      CREATE INDEX IF NOT EXISTS index_jobs_live_metadata ON index_jobs(status,space_id,job_type)
        WHERE status IN ('pending','running','failed');"
    ).map_err(|e|e.to_string())?;
    if !existed {
        tx.execute("INSERT INTO index_job_live_counts(space_id,job_type,status,jobs) SELECT space_id,job_type,status,COUNT(*) FROM index_jobs WHERE status IN ('pending','running','failed') GROUP BY space_id,job_type,status",[]).map_err(|e|e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())
}

const COUNTS_SQL: &str = "SELECT
    COALESCE(SUM(CASE WHEN status IN ('pending','running') THEN jobs ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN job_type IN ('download_source','import_local_source') AND status IN ('pending','running') THEN jobs ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN job_type='ocr_page' AND status IN ('pending','running') THEN jobs ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN job_type NOT IN ('download_source','import_local_source','ocr_page') AND status IN ('pending','running') THEN jobs ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN status='failed' THEN jobs ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN job_type='ocr_page' AND status='failed' THEN jobs ELSE 0 END),0),
    COALESCE(SUM(CASE WHEN job_type IN ('upsert_lexical','delete_lexical') AND status IN ('pending','running') THEN jobs ELSE 0 END),0)
    FROM index_job_live_counts WHERE (?1 IS NULL OR space_id=?1)
      AND NOT EXISTS(SELECT 1 FROM json_each(?2) hidden WHERE hidden.value=index_job_live_counts.space_id)";

pub(crate) fn counts(
    c: &Connection,
    scope: Option<&str>,
    hidden_json: &str,
) -> Result<(i64, i64, i64, i64, i64, i64, i64), String> {
    c.query_row(COUNTS_SQL, params![scope, hidden_json], |r| {
        Ok((
            r.get(0)?,
            r.get(1)?,
            r.get(2)?,
            r.get(3)?,
            r.get(4)?,
            r.get(5)?,
            r.get(6)?,
        ))
    })
    .map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    fn database() -> Connection {
        let c = Connection::open_in_memory().unwrap();
        c.execute_batch("CREATE TABLE index_jobs(id INTEGER PRIMARY KEY,space_id TEXT NOT NULL,job_type TEXT NOT NULL,status TEXT NOT NULL,updated_at INTEGER NOT NULL);
            INSERT INTO index_jobs VALUES(1,'a','ocr_page','pending',1),(2,'b','download_source','running',1),(3,'a','ocr_page','failed',1),(4,'a','upsert_lexical','completed',1);").unwrap();
        schema(&c).unwrap();
        c
    }
    fn assert_authoritative(c: &Connection) {
        let differences:i64=c.query_row("WITH expected AS (SELECT space_id,job_type,status,COUNT(*) jobs FROM index_jobs WHERE status IN ('pending','running','failed') GROUP BY space_id,job_type,status) SELECT (SELECT COUNT(*) FROM (SELECT * FROM expected EXCEPT SELECT * FROM index_job_live_counts))+(SELECT COUNT(*) FROM (SELECT * FROM index_job_live_counts EXCEPT SELECT * FROM expected))",[],|r|r.get(0)).unwrap();
        assert_eq!(differences, 0);
    }
    #[test]
    fn live_counts_upgrade_scope_hidden_mutations_rollback_and_reinstall_are_exact() {
        let mut c = database();
        assert_authoritative(&c);
        assert_eq!(counts(&c, None, "[]").unwrap(), (2, 1, 1, 0, 1, 1, 0));
        assert_eq!(counts(&c, Some("a"), "[]").unwrap(), (1, 0, 1, 0, 1, 1, 0));
        assert_eq!(counts(&c, None, "[\"a\"]").unwrap(), (1, 1, 0, 0, 0, 0, 0));
        c.execute_batch("UPDATE index_jobs SET status='running' WHERE id=1; UPDATE index_jobs SET space_id='a',job_type='upsert_lexical' WHERE id=2; UPDATE index_jobs SET status='pending' WHERE id=4;").unwrap();
        assert_authoritative(&c);
        {
            let tx = c.transaction().unwrap();
            tx.execute_batch("DELETE FROM index_jobs; INSERT INTO index_jobs VALUES(5,'c','ocr_page','pending',2);").unwrap();
        }
        assert_authoritative(&c);
        schema(&c).unwrap();
        assert_authoritative(&c);
        c.execute_batch("UPDATE index_jobs SET status='completed'; DELETE FROM index_jobs;")
            .unwrap();
        assert_authoritative(&c);
        assert_eq!(counts(&c, None, "[]").unwrap(), (0, 0, 0, 0, 0, 0, 0));
    }
    #[test]
    fn status_projection_does_not_grow_with_completed_history() {
        let c = database();
        c.execute_batch("WITH RECURSIVE n(i) AS (SELECT 5 UNION ALL SELECT i+1 FROM n WHERE i<50004) INSERT INTO index_jobs SELECT i,'a','ocr_page','completed',i FROM n;").unwrap();
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM index_jobs", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            50004
        );
        assert_eq!(
            c.query_row("SELECT COUNT(*) FROM index_job_live_counts", [], |r| r
                .get::<_, i64>(0))
                .unwrap(),
            3
        );
        assert_eq!(counts(&c, None, "[]").unwrap(), (2, 1, 1, 0, 1, 1, 0));
        let mut q = c
            .prepare(&format!("EXPLAIN QUERY PLAN {COUNTS_SQL}"))
            .unwrap();
        let plans = q
            .query_map(params![Option::<String>::None, "[]"], |r| {
                r.get::<_, String>(3)
            })
            .unwrap()
            .map(Result::unwrap)
            .collect::<Vec<_>>();
        assert!(plans.iter().any(|v| v.contains("index_job_live_counts")));
        assert!(!plans.iter().any(|v| v.contains("SCAN index_jobs")));
        let mut old=c.prepare("SELECT COALESCE(SUM(CASE WHEN status IN ('pending','running') THEN 1 ELSE 0 END),0) FROM index_jobs WHERE (?1 IS NULL OR space_id=?1) AND NOT EXISTS(SELECT 1 FROM json_each(?2) hidden WHERE hidden.value=index_jobs.space_id)").unwrap();
        let old_count: i64 = old
            .query_row(params![Option::<String>::None, "[]"], |r| r.get(0))
            .unwrap();
        let old_steps = old.get_status(rusqlite::StatementStatus::VmStep);
        let mut current = c.prepare(COUNTS_SQL).unwrap();
        let current_count: i64 = current
            .query_row(params![Option::<String>::None, "[]"], |r| r.get(0))
            .unwrap();
        let current_steps = current.get_status(rusqlite::StatementStatus::VmStep);
        assert_eq!(old_count, current_count);
        // The current projection returns all seven counters; even against the
        // old single counter, completed-history work must be eliminated.
        assert!(old_steps > current_steps * 100);
        eprintln!("HUB_JOB_STATUS_WORK {{\"historyRows\":50004,\"metadataRows\":3,\"oldSingleCounterVmSteps\":{old_steps},\"newSevenCountersVmSteps\":{current_steps}}}");
        let evidence = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../task-state/project-optimization-followup-20261012");
        if evidence.is_dir() {
            let value = serde_json::json!({"producer":"index_job_metadata::tests::status_projection_does_not_grow_with_completed_history","testExecutable":std::env::current_exe().unwrap(),"historyRows":50004,"metadataRows":3,"oldSingleCounterVmSteps":old_steps,"newSevenCountersVmSteps":current_steps,"oldCount":old_count,"newCount":current_count,"timingOrWholeAppCpuClaim":false});
            std::fs::write(
                evidence.join(format!("status-work-{}.json", std::process::id())),
                serde_json::to_vec_pretty(&value).unwrap(),
            )
            .unwrap();
        }
    }
}

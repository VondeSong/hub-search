//! Deterministic FSRS-6 scheduling using immutable, synchronized profiles.
//! Policy 1 fixes whole elapsed days, rounding and the 10-minute Again step.
//! Weight/retention changes get a new profile ID; policy changes need a new
//! scheduler version and replay path. Legacy histories use the frozen defaults.
use super::*;
use crate::flashcard_store::flashcard_by_id;
use crate::flashcard_study::legacy_scheduled_flashcard_values;
use fsrs::{MemoryState, FSRS};
use sha2::{Digest, Sha256};

const VERSION: i64 = 1;
const RETENTION: f32 = 0.9;
const DAY: i64 = 86_400;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Memory {
    stability: f32,
    difficulty: f32,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct State {
    version: i64,
    #[serde(default = "flashcard_profiles::default_id")]
    profile_id: String,
    memory: Option<Memory>,
    last_reviewed_at: Option<i64>,
    // Hash of the ordered event history, used to restore an exact undo only
    // when concurrent reviews have not changed its original predecessor.
    history_key: String,
    origin: Option<Origin>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Origin {
    memory: Option<Memory>,
    last_reviewed_at: Option<i64>,
    due: i64,
    interval: f64,
    ease: f64,
    repetitions: i64,
    lapses: i64,
}

impl Default for State {
    fn default() -> Self {
        Self {
            version: VERSION,
            profile_id: flashcard_profiles::default_id(),
            memory: None,
            last_reviewed_at: None,
            history_key: String::new(),
            origin: None,
        }
    }
}

fn decode(raw: &str) -> Result<State, String> {
    if raw.is_empty() {
        return Ok(State::default());
    }
    let s: State = serde_json::from_str(raw).map_err(|_| "闪卡记忆状态无效，请检查同步数据")?;
    if s.version != VERSION {
        return Err("闪卡使用了其他版本的记忆算法，请升级应用后再复习或同步".into());
    }
    if !valid_memory(&s.memory, s.last_reviewed_at)
        || (!s.history_key.is_empty()
            && (s.history_key.len() != 64 || !s.history_key.bytes().all(|b| b.is_ascii_hexdigit())))
    {
        return Err("闪卡记忆状态超出有效范围".into());
    }
    if let Some(base) = &s.origin {
        if !valid_memory(&base.memory, base.last_reviewed_at)
            || !base.interval.is_finite()
            || base.interval < 0.0
            || !base.ease.is_finite()
            || base.repetitions < 0
            || base.lapses < 0
        {
            return Err("闪卡初始复习状态无效".into());
        }
    } else {
        return Err("闪卡缺少初始复习状态".into());
    }
    Ok(s)
}

fn valid_memory(memory: &Option<Memory>, at: Option<i64>) -> bool {
    memory.is_some() == at.is_some()
        && at.is_none_or(|t| t >= 0)
        && memory.as_ref().is_none_or(|m| {
            m.stability.is_finite()
                && m.stability > 0.0
                && m.stability <= 36500.0
                && m.difficulty.is_finite()
                && (1.0..=10.0).contains(&m.difficulty)
        })
}

fn encode(s: &State) -> Result<String, String> {
    serde_json::to_string(s).map_err(|e| e.to_string())
}

pub(super) fn migrate(c: &mut Connection) -> Result<(), String> {
    let tx = c.transaction().map_err(|e| e.to_string())?;
    for (table, column, definition) in [
        ("flashcards", "fsrs_state_json", "TEXT NOT NULL DEFAULT ''"),
        (
            "flashcard_reviews",
            "scheduler_version",
            "INTEGER NOT NULL DEFAULT 0",
        ),
        (
            "flashcard_reviews",
            "previous_fsrs_state_json",
            "TEXT NOT NULL DEFAULT ''",
        ),
    ] {
        let exists: bool = tx
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM pragma_table_info(?1) WHERE name=?2)",
                params![table, column],
                |r| r.get(0),
            )
            .map_err(|e| e.to_string())?;
        if !exists {
            tx.execute_batch(&format!(
                "ALTER TABLE {table} ADD COLUMN {column} {definition};"
            ))
            .map_err(|e| e.to_string())?;
        }
    }
    tx.execute_batch("INSERT INTO metadata(key,value) VALUES('schema_version','67') ON CONFLICT(key) DO UPDATE SET value=excluded.value;")
        .map_err(|e| format!("无法升级闪卡记忆算法：{e}"))?;
    // Existing due dates and review records are deliberately left intact.
    tx.commit().map_err(|e| e.to_string())
}

pub(super) fn validate_snapshot(snapshot: &FlashcardSyncSnapshot) -> Result<(), String> {
    if !matches!(snapshot.version, 1..=5) {
        return Err(format!(
            "不支持远端闪卡同步版本 {}，请升级应用",
            snapshot.version
        ));
    }
    for profile in &snapshot.scheduler_profiles {
        profile.validate()?;
    }
    for card in &snapshot.cards {
        decode(&card.fsrs_state_json)?;
    }
    if snapshot.version < 5
        && snapshot
            .decks
            .iter()
            .any(|deck| !deck.parent_deck_id.is_empty())
    {
        return Err("子牌组数据需要闪卡同步协议版本 5，请升级 Hub".into());
    }
    for event in &snapshot.reviews {
        if !matches!(event.scheduler_version, 0 | VERSION) {
            return Err("远端复习记录的算法版本不支持，请升级应用".into());
        }
        if event.scheduler_version == VERSION
            && (event.previous_fsrs_state_json.is_empty()
                || !(1..=4).contains(&event.rating)
                || event.reviewed_at < 0)
        {
            return Err("远端 FSRS 复习记录不完整".into());
        }
        decode(&event.previous_fsrs_state_json)?;
        if snapshot.version >= 4
            && event.scheduler_version == VERSION
            && event.scheduler_profile_id.is_empty()
        {
            return Err("复习事件缺少算法参数身份".into());
        }
    }
    Ok(())
}

#[derive(Clone)]
struct Schedule {
    due: i64,
    interval: f64,
    ease: f64,
    repetitions: i64,
    lapses: i64,
    state: State,
    adopted: bool,
}

fn from_origin(base: Origin, adopted: bool) -> Schedule {
    Schedule {
        due: base.due,
        interval: base.interval,
        ease: base.ease,
        repetitions: base.repetitions,
        lapses: base.lapses,
        adopted,
        state: State {
            memory: base.memory.clone(),
            last_reviewed_at: base.last_reviewed_at,
            origin: Some(base),
            ..State::default()
        },
    }
}

fn remember_origin(s: &mut Schedule) {
    if s.state.origin.is_none() {
        s.state.origin = Some(Origin {
            memory: s.state.memory.clone(),
            last_reviewed_at: s.state.last_reviewed_at,
            due: s.due,
            interval: s.interval,
            ease: s.ease,
            repetitions: s.repetitions,
            lapses: s.lapses,
        });
    }
}

fn legacy_seed(
    due: i64,
    interval: f64,
    ease: f64,
    repetitions: i64,
    lapses: i64,
) -> Result<State, String> {
    if repetitions == 0 && lapses == 0 {
        return Ok(State::default());
    }
    // Imported cards without full review history retain their due date. This
    // is only an initial estimate; subsequent real reviews update the model.
    if !interval.is_finite() || !ease.is_finite() || interval < 0.0 {
        return Err("旧闪卡的复习间隔无效".into());
    }
    let memory = FSRS::new(&flashcard_profiles::DEFAULT_PARAMETERS)
        .map_err(|e| e.to_string())?
        .memory_state_from_sm2(
            ease.clamp(1.3, 3.2) as f32,
            interval.clamp(0.1, 36500.0) as f32,
            RETENTION,
        )
        .map_err(|e| e.to_string())?;
    let elapsed = if interval > 0.0 {
        (interval * DAY as f64).round() as i64
    } else {
        600
    };
    Ok(State {
        memory: Some(Memory {
            stability: memory.stability,
            difficulty: memory.difficulty,
        }),
        last_reviewed_at: Some(due.saturating_sub(elapsed).max(0)),
        ..State::default()
    })
}

fn events(c: &Connection, card_id: &str) -> Result<Vec<FlashcardSnapshotReview>, String> {
    flashcard_review_log::read(c, Some(card_id), true)
}

fn extend_history(state: &mut State, id: &str, rating: i64, at: i64, version: i64) {
    let bytes = serde_json::to_vec(&(&state.history_key, id, rating, at, version))
        .expect("serializable event identity");
    state.history_key = format!("{:x}", Sha256::digest(bytes));
}

#[cfg(test)]
fn next(current: &Schedule, rating: i64, at: i64) -> Result<Schedule, String> {
    next_with_profile(current, rating, at, &flashcard_profiles::default_profile())
}

fn next_with_profile(
    current: &Schedule,
    rating: i64,
    at: i64,
    profile: &flashcard_profiles::Profile,
) -> Result<Schedule, String> {
    if !(1..=4).contains(&rating) {
        return Err("复习评分必须在 1 到 4 之间".into());
    }
    let elapsed = current
        .state
        .last_reviewed_at
        .map(|last| at.saturating_sub(last).max(0) / DAY)
        .unwrap_or(0);
    let memory = current.state.memory.as_ref().map(|m| MemoryState {
        stability: m.stability,
        difficulty: m.difficulty,
    });
    let states = profile
        .model()?
        .next_states(
            memory,
            profile.desired_retention,
            elapsed.min(u32::MAX as i64) as u32,
        )
        .map_err(|e| format!("无法计算闪卡复习计划：{e}"))?;
    let item = match rating {
        1 => states.again,
        2 => states.hard,
        3 => states.good,
        _ => states.easy,
    };
    let seconds = if rating == 1 {
        profile.again_seconds
    } else {
        item.interval.round().clamp(
            profile.minimum_interval_days as f32,
            profile.maximum_interval_days as f32,
        ) as i64
            * DAY
    };
    let due = at.checked_add(seconds).ok_or("闪卡到期时间超出范围")?;
    Ok(Schedule {
        due,
        interval: seconds as f64 / DAY as f64,
        ease: current.ease,
        repetitions: if rating == 1 {
            0
        } else {
            current.repetitions.saturating_add(1)
        },
        lapses: current.lapses.saturating_add(i64::from(rating == 1)),
        adopted: true,
        state: State {
            version: VERSION,
            profile_id: profile.id.clone(),
            memory: Some(Memory {
                stability: item.memory.stability,
                difficulty: item.memory.difficulty,
            }),
            last_reviewed_at: Some(at),
            history_key: current.state.history_key.clone(),
            origin: current.state.origin.clone(),
        },
    })
}

fn replay(c: &Connection, events: &[FlashcardSnapshotReview]) -> Result<Option<Schedule>, String> {
    let Some(first) = events.first() else {
        return Ok(None);
    };
    let ease = first.previous_ease.unwrap_or(2.5);
    let reps = first.previous_repetitions.unwrap_or(0);
    let lapses = first.previous_lapses.unwrap_or(0);
    let state = if first.previous_fsrs_state_json.is_empty() {
        legacy_seed(
            first.previous_due_at,
            first.previous_interval_days,
            ease,
            reps,
            lapses,
        )?
    } else {
        decode(&first.previous_fsrs_state_json)?
    };
    let mut schedule = Schedule {
        due: first.previous_due_at,
        interval: first.previous_interval_days,
        ease,
        repetitions: reps,
        lapses,
        state,
        adopted: false,
    };
    // The immutable origin survives deletion of the first review. Seeding from
    // that review's successor's immediate previous state would undo nothing.
    for event in events {
        if !event.previous_fsrs_state_json.is_empty() {
            if let Some(base) = decode(&event.previous_fsrs_state_json)?.origin {
                schedule = from_origin(base, false);
                break;
            }
        }
    }
    remember_origin(&mut schedule);
    for event in events {
        if !matches!(event.scheduler_version, 0 | VERSION) {
            return Err("复习算法版本不支持".into());
        }
        let use_fsrs = schedule.adopted || event.scheduler_version == VERSION;
        let profile = if event.scheduler_version == VERSION {
            flashcard_profiles::get(
                c,
                &flashcard_review_log::normalize(event).scheduler_profile_id,
            )?
        } else if use_fsrs {
            flashcard_profiles::get(c, &schedule.state.profile_id)?
        } else {
            flashcard_profiles::default_profile()
        };
        let mut computed = next_with_profile(&schedule, event.rating, event.reviewed_at, &profile)?;
        if !use_fsrs {
            let (due, interval, ease, reps, lapses) = legacy_scheduled_flashcard_values(
                event.rating,
                schedule.interval,
                schedule.ease,
                schedule.repetitions,
                schedule.lapses,
                event.reviewed_at,
            );
            computed.due = due;
            computed.interval = interval;
            computed.ease = ease;
            computed.repetitions = reps;
            computed.lapses = lapses;
            computed.adopted = false;
        }
        extend_history(
            &mut computed.state,
            &event.id,
            event.rating,
            event.reviewed_at,
            event.scheduler_version,
        );
        schedule = computed;
    }
    Ok(Some(schedule))
}

fn load(c: &Connection, card: &Flashcard) -> Result<Schedule, String> {
    if let Some(s) = derived(c, &card.id)? {
        if s.adopted {
            return Ok(s);
        }
    }
    let raw: String = c
        .query_row(
            "SELECT fsrs_state_json FROM flashcards WHERE id=?1",
            [&card.id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let state = if !raw.is_empty() {
        decode(&raw)?
    } else if let Some(history) = replay(c, &events(c, &card.id)?)? {
        history.state
    } else {
        legacy_seed(
            card.due_at,
            card.interval_days,
            card.ease,
            card.repetitions,
            card.lapses,
        )?
    };
    let mut s = Schedule {
        due: card.due_at,
        interval: card.interval_days,
        ease: card.ease,
        repetitions: card.repetitions,
        lapses: card.lapses,
        state,
        adopted: !raw.is_empty(),
    };
    remember_origin(&mut s);
    Ok(s)
}

fn save(c: &Connection, card_id: &str, s: &Schedule, changed_at: i64) -> Result<(), String> {
    let raw = if s.adopted {
        encode(&s.state)?
    } else {
        String::new()
    };
    c.execute(
        "UPDATE flashcards SET due_at=?2,interval_days=?3,ease=?4,repetitions=?5,lapses=?6,
        fsrs_state_json=?7,updated_at=MAX(updated_at,?8) WHERE id=?1",
        params![
            card_id,
            s.due,
            s.interval,
            s.ease,
            s.repetitions,
            s.lapses,
            raw,
            changed_at
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

fn previous(event: &FlashcardSnapshotReview) -> Result<Schedule, String> {
    let state = if event.previous_fsrs_state_json.is_empty() {
        legacy_seed(
            event.previous_due_at,
            event.previous_interval_days,
            event.previous_ease.unwrap_or(2.5),
            event.previous_repetitions.unwrap_or(0),
            event.previous_lapses.unwrap_or(0),
        )?
    } else {
        decode(&event.previous_fsrs_state_json)?
    };
    let mut s = Schedule {
        due: event.previous_due_at,
        interval: event.previous_interval_days,
        ease: event.previous_ease.unwrap_or(2.5),
        repetitions: event.previous_repetitions.unwrap_or(0),
        lapses: event.previous_lapses.unwrap_or(0),
        state,
        adopted: !event.previous_fsrs_state_json.is_empty(),
    };
    remember_origin(&mut s);
    Ok(s)
}

fn derived(c: &Connection, card_id: &str) -> Result<Option<Schedule>, String> {
    let all = flashcard_review_log::read(c, Some(card_id), false)?;
    let Some(first) = all.first() else {
        return Ok(None);
    };
    let active = events(c, card_id)?;
    let remaining = replay(c, &active)?;
    let key = remaining
        .as_ref()
        .map(|s| s.state.history_key.as_str())
        .unwrap_or("");
    let active_ids: HashSet<_> = active.iter().map(|e| e.id.as_str()).collect();
    for revoked in &all {
        if !active_ids.contains(revoked.id.as_str())
            && !revoked.previous_fsrs_state_json.is_empty()
            && active
                .last()
                .is_none_or(|e| (e.reviewed_at, &e.id) < (revoked.reviewed_at, &revoked.id))
        {
            let before = previous(revoked)?;
            if before.state.history_key == key {
                return Ok(Some(before));
            }
        }
    }
    if remaining.is_some() {
        return Ok(remaining);
    }
    let before = previous(first)?;
    Ok(Some(from_origin(
        before.state.origin.ok_or("复习记录缺少初始状态")?,
        before.adopted,
    )))
}

pub(super) fn recompute(c: &Connection, card_id: &str) -> Result<(), String> {
    flashcard_review_log::project(c, card_id)?;
    if let Some(s) = derived(c, card_id)? {
        save(c, card_id, &s, s.state.last_reviewed_at.unwrap_or(0))?;
    }
    Ok(())
}

// Preserve a newer algorithm's state when an older device edits card content.
// Reviews remain the authority whenever either device has FSRS events.
pub(super) fn protect_schedule(
    c: &Connection,
    card: &mut FlashcardSnapshotCard,
) -> Result<(), String> {
    if !card.fsrs_state_json.is_empty() {
        return Ok(());
    }
    let local:Option<(String,i64,f64,f64,i64,i64)> = c.query_row(
        "SELECT fsrs_state_json,due_at,interval_days,ease,repetitions,lapses FROM flashcards WHERE id=?1", [&card.id],
        |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?,r.get(5)?))).optional().map_err(|e| e.to_string())?;
    if let Some((state, due, interval, ease, reps, lapses)) = local.filter(|s| !s.0.is_empty()) {
        card.fsrs_state_json = state;
        card.due_at = due;
        card.interval_days = interval;
        card.ease = ease;
        card.repetitions = reps;
        card.lapses = lapses;
    }
    Ok(())
}

fn review_time(s: &Schedule, now: i64) -> Result<i64, String> {
    // A per-card monotonic second keeps rapid local reviews in their actual
    // order even though legacy review timestamps have second resolution.
    let last = s.state.last_reviewed_at.unwrap_or(0);
    if last > now.saturating_add(60) {
        return Err("设备时间早于最近复习，请校准时间后重试".into());
    }
    Ok(now.max(last.saturating_add(1)))
}

fn review_key(card: &Flashcard, s: &Schedule, at: i64) -> Result<String, String> {
    let elapsed = s
        .state
        .last_reviewed_at
        .map(|last| at.saturating_sub(last).max(0) / DAY)
        .unwrap_or(0);
    let bytes = serde_json::to_vec(&(card, &s.state, elapsed)).map_err(|e| e.to_string())?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct Preview {
    card_id: String,
    review_key: String,
    desired_retention: f32,
    choices: Vec<Choice>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Choice {
    rating: i64,
    interval_seconds: i64,
}

pub(super) fn preview(c: &Connection, card_id: &str, now: i64) -> Result<Preview, String> {
    let card = flashcard_by_id(c, card_id)?;
    if card.status != "active" {
        return Err("这张闪卡已暂停学习，请先恢复".into());
    }
    let s = load(c, &card)?;
    let at = review_time(&s, now)?;
    let profile = flashcard_profiles::get(c, &s.state.profile_id)?;
    let choices = (1..=4)
        .map(|rating| {
            next_with_profile(&s, rating, at, &profile).map(|n| Choice {
                rating,
                interval_seconds: n.due - at,
            })
        })
        .collect::<Result<_, _>>()?;
    Ok(Preview {
        card_id: card.id.clone(),
        review_key: review_key(&card, &s, at)?,
        desired_retention: profile.desired_retention,
        choices,
    })
}

pub(super) fn preview_presented(
    c: &Connection,
    card_id: &str,
    expected_card: &Flashcard,
    now: i64,
) -> Result<Preview, String> {
    // The question the user saw and the key being issued must share one read
    // snapshot. A timestamp alone cannot distinguish edits within one second.
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let current = flashcard_by_id(&tx, card_id)?;
    if expected_card.id != card_id
        || serde_json::to_value(&current).map_err(|e| e.to_string())?
            != serde_json::to_value(expected_card).map_err(|e| e.to_string())?
    {
        return Err("卡片内容或复习状态已变化，请重新加载卡片后再作答".into());
    }
    let result = preview(&tx, card_id, now)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

#[tauri::command]
pub(super) fn preview_flashcard_review(
    app: AppHandle,
    card_id: String,
    expected_card: Flashcard,
) -> Result<Preview, String> {
    let c = open_database(&database_path(&app)?)?;
    preview_presented(&c, &card_id, &expected_card, now_timestamp())
}

pub(super) fn commit(
    c: &Connection,
    card_id: &str,
    rating: i64,
    elapsed_ms: Option<i64>,
    expected_key: &str,
    now: i64,
) -> Result<FlashcardReviewResult, String> {
    let tx = c.unchecked_transaction().map_err(|e| e.to_string())?;
    let card = flashcard_by_id(&tx, card_id)?;
    if card.status != "active" {
        return Err("这张闪卡已暂停学习，请先恢复".into());
    }
    let previous = load(&tx, &card)?;
    let at = review_time(&previous, now)?;
    if review_key(&card, &previous, at)? != expected_key {
        return Err("复习计划已变化，已刷新间隔，请重新评分".into());
    }
    let profile = flashcard_profiles::get(&tx, &previous.state.profile_id)?;
    let mut schedule = next_with_profile(&previous, rating, at, &profile)?;
    let review_id = format!("review-{}", random_url_safe(12));
    extend_history(&mut schedule.state, &review_id, rating, at, VERSION);
    save(
        &tx,
        card_id,
        &schedule,
        now.max(card.updated_at.saturating_add(1)),
    )?;
    flashcard_review_log::insert_active(
        &tx,
        &FlashcardSnapshotReview {
            id: review_id.clone(),
            card_id: card_id.into(),
            rating,
            reviewed_at: at,
            previous_due_at: previous.due,
            next_due_at: schedule.due,
            previous_interval_days: previous.interval,
            next_interval_days: schedule.interval,
            elapsed_ms: elapsed_ms.map(|v| v.clamp(0, 86_400_000)),
            previous_ease: Some(previous.ease),
            previous_repetitions: Some(previous.repetitions),
            previous_lapses: Some(previous.lapses),
            scheduler_version: VERSION,
            previous_fsrs_state_json: encode(&previous.state)?,
            scheduler_profile_id: profile.id,
        },
    )?;
    mark_flashcard_sync_dirty(&tx)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(FlashcardReviewResult {
        card: flashcard_by_id(c, card_id)?,
        review_id,
    })
}

pub(super) fn restore(
    c: &Connection,
    review_id: &str,
    changed_at: i64,
) -> Result<Option<String>, String> {
    let Some(event) = flashcard_review_log::get(c, review_id)? else {
        return Ok(None);
    };
    record_flashcard_tombstone(c, "review", review_id, changed_at)?;
    recompute(c, &event.card_id)?;
    c.execute(
        "UPDATE flashcards SET updated_at=MAX(updated_at,?1) WHERE id=?2",
        params![changed_at, event.card_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(Some(event.card_id))
}

#[cfg(test)]
#[path = "flashcard_scheduler_tests.rs"]
mod tests;

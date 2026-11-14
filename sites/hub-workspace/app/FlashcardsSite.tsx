"use client";

import {useEffect, useRef, useState, type CSSProperties} from "react";
import {ArrowLeft, ArrowRight, ArrowUpRight, BarChart3, BookOpen, BookOpenCheck, Check, ChevronLeft, ChevronRight, CircleHelp, Cloud, Clock3, Command, Inbox, Layers3, LayoutGrid, List, PanelLeft, Play, RotateCcw, Search, Settings2, SkipForward, Sun, Wrench, X, Link2} from "lucide-react";
import {dailyLimits, sessionLimits, type DemoCard} from "./flashcard-demo";
import {FLASH_STORAGE_KEY, makeFlashState, loadFlashState, reconcileFlashDay, buildFlashSession, reconcileFlashSession, applyFlashRating, restoreFlashRating, getFlashCardStatus, type FlashState, cardsForState, planForState, effectiveNewLimit, addExtraNew, nextDue, studyStreak, estimateMinutes, sampleIntervals} from "./flashcard-state";
import {FlashcardExamples,FlashcardRhythm,FlashcardFuture,FlashcardDrafts} from "./FlashcardPrototypeExtras";
import "./flashcard-experience.css";

type Page = "due" | "cards" | "inbox" | "stats" | "deck";
type Filter = "all" | "due" | "new" | "done" | "suspended";
type Dialog = {kind: "preview"; cardId: string; hideAnswer?:boolean} | {kind:"edit"|"feedback";cardId:string} | {kind: "settings" | "help" | "about"} | null;
const decks = [{name: "学习笔记", description: "阅读、思考与日常发现", tone: "green", Icon: BookOpen}, {name: "工程知识", description: "把实践沉淀为经验", tone: "blue", Icon: Wrench}];
const statusNames = {new: "新卡片", due: "待复习", done: "已复习", suspended:"已暂停"};
const ratingNames = ["重来", "困难", "记得", "轻松"];
const ratingHints = ["本轮再看", "还需巩固", "回忆顺畅", "已经熟悉"];
const typeLabel=(card:DemoCard)=>card.cardType==="multiple_choice"?"选择题":card.cardType==="typed_answer"?"填空题":"问答卡";

export default function FlashcardsSite({navigationOpen, onToggleNavigation, onExit,navigationResizer,navigationWidth,onCloud}: {onCloud:()=>void;navigationResizer?:React.ReactNode;navigationWidth:number;navigationOpen: boolean; onToggleNavigation: () => void; onExit: () => void}) {
  const rootRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const studyRef = useRef<HTMLElement>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const ratingLock = useRef(false);
  const [page, setPage] = useState<Page>("due");
  const [deck, setDeck] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [layout, setLayout] = useState<"grid" | "list">("grid");
  const [state, setState] = useState<FlashState>(makeFlashState);
  const [ready, setReady] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const [reviewing, setReviewing] = useState(false);
  const [undo, setUndo] = useState<FlashState | null>(null);
  const [dialog, setDialog] = useState<Dialog>(null);
  const [notice, setNotice] = useState("");
  const[previewRevealed,setPreviewRevealed]=useState(false);
  const[editQuestion,setEditQuestion]=useState(""),[editAnswer,setEditAnswer]=useState(""),[feedback,setFeedback]=useState("");
  const studyStarted=useRef(0);

  useEffect(() => {
    try {setState(loadFlashState(localStorage.getItem(FLASH_STORAGE_KEY)));} catch {setStorageOk(false);}
    setReady(true);
  }, []);
  useEffect(() => {
    if (!ready) return;
    try {localStorage.setItem(FLASH_STORAGE_KEY, JSON.stringify(state)); setStorageOk(true);} catch {setStorageOk(false);}
  }, [state, ready]);
  useEffect(() => {
    const refreshDay = () => setState(previous => reconcileFlashDay(previous));
    const timer = window.setInterval(refreshDay, 60000);
    window.addEventListener("focus", refreshDay);
    document.addEventListener("visibilitychange", refreshDay);
    return () => {window.clearInterval(timer); window.removeEventListener("focus", refreshDay); document.removeEventListener("visibilitychange", refreshDay);};
  }, []);
  useEffect(() => {setReviewing(false); setUndo(null);}, [state.date]);
  useEffect(() => {if (!notice) return; const timer = window.setTimeout(() => setNotice(""), 2800); return () => window.clearTimeout(timer);}, [notice]);
  useEffect(() => {mainRef.current?.scrollTo({top: 0});}, [page, deck, reviewing]);

  const session = state.session;
  const cards=cardsForState(state);
  const current = cards.find(card => card.id === session?.queue[0]);
  const response=session?.responses?.[current?.id??''];const choice=response?.choice??null,typed=response?.typed??'';
  const setChoice=(value:number|null)=>setState(s=>!s.session||!current||s.session.queue[0]!==current.id?s:{...s,session:{...s.session,responses:{...s.session.responses,[current.id]:{choice:value,typed:s.session.responses?.[current.id]?.typed??''}}}});
  const setTyped=(value:string)=>setState(s=>!s.session||!current||s.session.queue[0]!==current.id?s:{...s,session:{...s.session,responses:{...s.session.responses,[current.id]:{choice:s.session.responses?.[current.id]?.choice??null,typed:value}}}});
  const revealed = Boolean(session?.revealed);
  const activeSession = Boolean(session?.queue.length);
  const todayPlan = planForState(state,0);
  const plan = planForState(state,state.sessionLimit,page === "deck"?deck:"");
  const newCount = todayPlan.eligible.filter(card => getFlashCardStatus(card, state) === "new").length;
  const waiting=Math.max(0,cards.filter(c=>state.due.includes(c.id)&&c.isNew&&!state.learned.includes(c.id)&&!state.suspended.includes(c.id)).length-newCount);
  const streak=studyStreak(state),minutes=estimateMinutes(state,plan.session.length),upcoming=nextDue(state);
  const recommended=!revealed?null:current?.cardType==="multiple_choice"&&choice!==null?(choice===current.correctChoice?3:1):current?.cardType==="typed_answer"?(typed.normalize("NFKC").trim().toLocaleLowerCase()===(current.acceptedAnswer??"").normalize("NFKC").trim().toLocaleLowerCase()&&typed.trim()?3:1):null;
  const nextCard = (activeSession && current) || todayPlan.eligible[0] || cards.find(c=>state.due.includes(c.id)&&!state.suspended.includes(c.id)) || cards[0];
  const scopeCards = cards.filter(card => page !== "deck" || card.deck === deck);
  const filtered = scopeCards.filter(card => (filter === "all" || getFlashCardStatus(card, state) === filter) && `${card.question} ${card.answer} ${card.source} ${card.deck}`.toLowerCase().includes(query.trim().toLowerCase()));
  const previewCard = dialog?.kind === "preview" ? cards.find(card => card.id === dialog.cardId) : null;
  const previewPool = filtered.length && previewCard && filtered.some(card => card.id === previewCard.id) ? filtered : cards;
  const previewIndex = previewPool.findIndex(card => card.id === previewCard?.id);
  const completed = session ? session.initialIds.length - session.queue.length : 0;
  const dayDate = new Date(`${state.date}T12:00:00+08:00`);
  const dateLabel = new Intl.DateTimeFormat("zh-CN", {month: "long", day: "numeric", weekday: "long", timeZone: "Asia/Shanghai"}).format(dayDate);
  const pageTitle = page === "due" ? "今日" : page === "cards" ? "全部卡片" : page === "deck" ? deck : page === "stats" ? "学习统计" : "收件箱";

  const closeMobileNavigation = () => {if (window.innerWidth < 900 && navigationOpen) onToggleNavigation();};
  const navigate = (next: Page, nextDeck = "") => {setPage(next); setDeck(nextDeck); setQuery(""); setFilter("all"); setReviewing(false); setDialog(null); closeMobileNavigation();};
  const openSearch = () => {navigate("cards"); window.setTimeout(() => searchRef.current?.focus(), 0);};
  const start = (targetDeck = page === "deck" ? deck : "") => {
    const fresh = reconcileFlashSession(reconcileFlashDay(state));
    if (fresh.session?.queue.length) {setState(fresh); setReviewing(true); setDialog(null); return;}
    const next = buildFlashSession(fresh, targetDeck);
    if (!next) return;
    setState({...fresh, session: next}); setUndo(null); setReviewing(true); setDialog(null);
  };
  const reveal = () => {if (current) setState(previous => previous.session ? {...previous, session: {...previous.session, revealed: true}} : previous);};
  const rate = (rating: number) => {
    if (!current || !revealed || ratingLock.current) return;
    const fresh = reconcileFlashDay(state);
    if (fresh.date !== state.date) {setState(fresh); setReviewing(false); setNotice("新的一天开始了，已更新今日计划"); return;}
    ratingLock.current = true;
    const next = applyFlashRating(state, rating,Math.max(0,performance.now()-studyStarted.current));
    if (next === state) {ratingLock.current = false; return;}
    setUndo(state); setState(next);
  };
  const restoreRating = () => {if (!undo) return; setState(restoreFlashRating(state, undo)); setUndo(null); setReviewing(true); setNotice("已撤销上一张评分");};
  const skip = () => {if (!session || session.queue.length < 2) return; setState({...state, session: {...session, queue: [...session.queue.slice(1), session.queue[0]], revealed: false}}); setNotice("已放到本轮最后");};
  const updatePreference = (name: "dailyLimit" | "sessionLimit", value: number) => setState(previous => reconcileFlashSession({...previous, [name]: value}));
  const grantExtra=()=>{const fresh=addExtraNew(state,Math.min(5,waiting));setState({...fresh,session:fresh.session?.queue.length?fresh.session:buildFlashSession(fresh)});setUndo(null);setReviewing(true);setDialog(null);setNotice("仅本示例日增加额度；每日偏好不变，新卡仍计入今日统计。");};
  const resetExample=()=>{setReviewing(false);setUndo(null);setDialog(null);setPage("due");setQuery("");};
  const editCard=(card:DemoCard)=>{setEditQuestion(card.question);setEditAnswer(card.answer);setDialog({kind:"edit",cardId:card.id});};
  const suspendCard=(card:DemoCard)=>{const paused=state.suspended.includes(card.id);const fresh=reconcileFlashSession({...state,suspended:paused?state.suspended.filter(id=>id!==card.id):[...state.suspended,card.id]});setState(fresh);if(!fresh.session)setReviewing(false);setDialog(null);setNotice(paused?"已恢复示例卡片学习":"已暂停学习，可在牌库恢复；不是仅今天隐藏。");};
  useEffect(()=>{setPreviewRevealed(false);},[dialog?.kind,dialog?.kind==="preview"?dialog.cardId:null]);
  useEffect(()=>{studyStarted.current=performance.now();},[current?.id,reviewing]);


  useEffect(() => {
    ratingLock.current = false;
    if (reviewing && !dialog) studyRef.current?.focus({preventScroll: true});
  }, [current?.id, revealed, reviewing]);

  useEffect(() => {
    if (!dialog) return;
    const previous = document.activeElement as HTMLElement | null;
    const modal = dialogRef.current;
    modal?.querySelector<HTMLElement>("[data-initial-focus]")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {event.preventDefault(); event.stopImmediatePropagation(); setDialog(null);}
      if (event.key === "Tab" && modal) {
        const elements = Array.from(modal.querySelectorAll<HTMLElement>('button:not(:disabled),input,select,textarea,a[href],[tabindex="0"]'));
        const first = elements[0], last = elements[elements.length - 1];
        if (event.shiftKey && document.activeElement === first) {event.preventDefault(); last?.focus();}
        else if (!event.shiftKey && document.activeElement === last) {event.preventDefault(); first?.focus();}
      }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {document.removeEventListener("keydown", onKey, true); if (previous?.isConnected) previous.focus({preventScroll: true});};
  }, [dialog?.kind]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (dialog || event.isComposing || event.repeat) return;
      const editable = (event.target as HTMLElement)?.closest("input,textarea,select,[contenteditable=true]");
      const commandSearch = (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k";
      if (commandSearch || (event.key === "/" && !editable)) {event.preventDefault(); event.stopImmediatePropagation(); openSearch(); return;}
      if (editable || event.metaKey || event.ctrlKey || event.altKey || !reviewing) return;
      let handled = true;
      if (event.key === "Escape") setReviewing(false);
      else if (event.key === " " && current && !revealed) reveal();
      else if (/^[1-4]$/.test(event.key) && revealed) rate(Number(event.key));
      else if (event.key.toLowerCase() === "u" && undo) restoreRating();
      else if (event.key.toLowerCase() === "s" && current) skip();
      else handled = false;
      if (handled) {event.preventDefault(); event.stopImmediatePropagation();}
    };
    document.addEventListener("keydown", onKey, true);
    return () => document.removeEventListener("keydown", onKey, true);
  });

  const metrics = <div className="fc-metrics" aria-label="今日学习概览">
    <div className="fc-metric"><span className="fc-metric-label"><BookOpenCheck size={16}/>今日复习</span><div><strong>{state.reviewed}</strong><small>次</small></div><p>每一次回想，都是积累</p></div>
    <div className="fc-metric"><span className="fc-metric-label"><Layers3 size={16}/>新卡学习</span><div><strong>{state.newToday}</strong><small>{state.dailyLimit ? `/ ${effectiveNewLimit(state)} 张` : "张 · 不限额"}</small></div><p>{state.extraNew ? `每日 ${state.dailyLimit} 张 + 今日额外 ${state.extraNew} 张` : state.dailyLimit ? `今天还可学习 ${Math.max(0, effectiveNewLimit(state) - state.newToday)} 张新卡` : "按照自己的节奏"}</p></div>
    <div className="fc-metric"><span className="fc-metric-label"><Sun size={16}/>连续学习</span><div><strong>{streak.days}</strong><small>天</small></div><p>{streak.today?"含今日示例记录":streak.days?"已保留到昨天，今天可以继续":"这次从今天开始"}</p></div>
  </div>;
  const rhythm=<FlashcardRhythm state={state}/>;
  const startLabel = activeSession ? `继续复习 ${session!.queue.length} 张` : plan.session.length ? `开始复习 ${plan.session.length} 张` : waiting ? "新卡额度已用完" : "今日已完成";
  const cardBadge = (card: DemoCard) => <span className="fc-badge" data-status={getFlashCardStatus(card, state)}><i/>{statusNames[getFlashCardStatus(card, state)]}</span>;

  return <section ref={rootRef} className="flashcards-workspace site-flashcards fc-workspace" style={{"--fc-sidebar-width": `${navigationWidth}px`} as CSSProperties} aria-label="闪卡工作台">
    <header className="fc-topbar" inert={Boolean(dialog)}>
      <div className="fc-topbar-left"><button className="fc-icon-button" aria-label={reviewing ? "暂停并返回" : navigationOpen ? "收起闪卡导航" : "展开闪卡导航"} title={reviewing ? "暂停并返回" : "切换导航"} onClick={() => reviewing ? setReviewing(false) : onToggleNavigation()}>{reviewing ? <ArrowLeft size={18}/> : <PanelLeft size={18}/>}</button><nav className="fc-breadcrumb" aria-label="当前位置"><button onClick={() => navigate("due")}>闪卡</button><ChevronRight size={13}/><span>{reviewing ? "专注复习" : pageTitle}</span></nav></div>
      <div className="fc-topbar-right"><button className="fc-icon-button" aria-label="云同步中心" title="云同步中心" onClick={onCloud}><Cloud size={17}/></button><span className="fc-topbar-chip"><i/>{storageOk ? "本地示例" : "暂未保存"}</span><button className="fc-icon-button" aria-label="搜索卡片" title="搜索卡片 /" onClick={openSearch}><Search size={17}/></button><button className="fc-icon-button" aria-label="复习偏好" title="复习偏好" onClick={() => setDialog({kind: "settings"})}><Settings2 size={17}/></button><button className="fc-icon-button" aria-label="键盘快捷键" title="键盘快捷键" onClick={() => setDialog({kind: "help"})}><CircleHelp size={17}/></button></div>
    </header>

    <div className={`fc-body ${!navigationOpen ? "is-collapsed" : ""} ${reviewing ? "is-studying" : ""}`} inert={Boolean(dialog)}>
      {navigationOpen && !reviewing && <><button className="fc-navigation-scrim" aria-label="收起闪卡侧栏" onClick={onToggleNavigation}/><aside id="hub-module-navigation" className="fc-sidebar" aria-label="闪卡导航">
        <div className="fc-sidebar-brand"><span><BookOpenCheck size={22}/></span><div><strong>闪卡</strong><small>让知识留下来</small></div></div>
        <button className="fc-sidebar-search" onClick={openSearch}><Search size={15}/><span>搜索卡片</span><kbd>/</kbd></button>
        <nav className="fc-nav">{([{id: "due", name: "今日", Icon: Sun, count: todayPlan.eligible.length}, {id: "cards", name: "全部卡片", Icon: Layers3, count: cards.length}, {id: "inbox", name: "收件箱", Icon: Inbox, count: state.drafts.length}, {id: "stats", name: "学习统计", Icon: BarChart3, count: null}] as const).map(item => <button key={item.id} className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined} onClick={() => navigate(item.id)}><item.Icon size={17}/><span>{item.name}</span>{item.count !== null && <small>{item.count}</small>}</button>)}</nav>
        <div className="fc-sidebar-label">我的牌组 <span>{decks.length}</span></div>
        {decks.map(({name, tone, Icon}) => <button key={name} className={`fc-deck-link ${page === "deck" && deck === name ? "active" : ""}`} aria-current={page === "deck" && deck === name ? "page" : undefined} onClick={() => navigate("deck", name)}><span className="fc-deck-dot" data-tone={tone}><Icon size={15}/></span><span>{name}</span><small>{cards.filter(card => card.deck === name).length}</small></button>)}
        {activeSession && <button className="fc-sidebar-resume" onClick={() => start()}><Play size={15}/><span>继续上次复习<small>{session!.label} · 剩余 {session!.queue.length} 张</small></span><ChevronRight size={14}/></button>}
        <div className="fc-sidebar-bottom"><button onClick={() => setDialog({kind: "about"})}><span className="fc-saved-dot"/>仅保存在本浏览器<CircleHelp size={13}/></button><button onClick={onExit}><ArrowLeft size={14}/>返回我的 Hub</button></div>
      </aside>{navigationResizer}</>}

      <div ref={mainRef} className="fc-main">
        {reviewing ? <div className="fc-study-content">
          <div className="fc-study-top"><button className="fc-quiet" onClick={() => setReviewing(false)}><ArrowLeft size={15}/>暂停复习</button><span>{session?.label || "今日复习"}</span><small>{completed} / {session?.initialIds.length || 0} 已完成</small></div>
          <div className="fc-study-progress" role="progressbar" aria-label="本轮复习进度" aria-valuenow={completed} aria-valuemin={0} aria-valuemax={session?.initialIds.length || 1}><span style={{width: `${session?.initialIds.length ? completed / session.initialIds.length * 100 : 0}%`}}/></div>
          <p className="fc-sr-only" role="status">{current ? `剩余 ${session?.queue.length} 张。${revealed ? "答案已展开，可按数字 1 到 4 评分" : "请先回忆，再显示答案"}` : "本轮复习完成"}</p>
          {current ? <><article onClick={event=>{if(!revealed&&!(event.target as HTMLElement).closest("input,button,label,textarea,a"))reveal();}} ref={studyRef} tabIndex={-1} className={`fc-study-card ${revealed ? "is-revealed" : ""}`} aria-label={current.question}>
            <div className="fc-study-card-head"><span><Layers3 size={15}/>{current.deck}</span><small>{typeLabel(current)}</small></div>
            <div className="fc-study-question"><span className="fc-question-label">先想一想</span><h2>{current.question}</h2>{!revealed && <p>先回忆，再轻点卡片或显示答案。</p>}</div>
            {current.cardType==="multiple_choice"&&<fieldset className="fc-objective" disabled={revealed}><legend>选择你的答案</legend>{current.choices?.map((text,index)=><label key={text}><input type="radio" name="sample-choice" checked={choice===index} onChange={()=>setChoice(index)}/><span>{text}</span></label>)}</fieldset>}
            {current.cardType==="typed_answer"&&<label className="fc-objective">填写空缺<input type="text" aria-label="填空题答案" value={typed} disabled={revealed} onChange={e=>setTyped(e.target.value)} placeholder="先尝试回忆…"/></label>}
            {revealed&&recommended!==null&&<p className="fc-recommendation" role="status">{recommended===3?"回答符合示例答案，建议记得。":"回答未匹配示例答案，建议重来。"}仍需由你选择评分，不会自动提交。</p>}
            {revealed && <div className="fc-answer"><span className="fc-answer-label"><Check size={14}/>参考答案</span><p>{current.answer}</p><div className="fc-source"><Link2 size={13}/>{current.source}</div></div>}
            {!revealed && <div className="fc-card-corner">{String(completed + 1).padStart(2, "0")}<span> / {String(session?.initialIds.length || 0).padStart(2, "0")}</span></div>}
          </article>
          {!revealed ? <div className="fc-reveal-wrap"><button className="fc-primary fc-study-reveal" onClick={reveal}>显示答案<kbd>Space</kbd></button></div> : <div className="fc-rating-bar" aria-label="根据回忆情况评分">{ratingNames.map((name, index) => <button key={name} className={`rating-${index + 1}`} data-recommended={recommended===index+1} aria-label={`${index + 1} ${name}，${ratingHints[index]}，示例间隔 ${sampleIntervals[index]}`} onClick={() => rate(index + 1)}><kbd>{index + 1}</kbd><span><strong>{name}</strong><small>示例 · {sampleIntervals[index]}</small></span></button>)}</div>}
          {revealed&&<p className="fc-interval-note">间隔为固定示例，不是实时 FSRS 预测。</p>}
          <div className="fc-study-tools"><button className="fc-quiet" onClick={()=>editCard(current)}>编辑</button><button className="fc-quiet" onClick={()=>{setFeedback("");setDialog({kind:"feedback",cardId:current.id});}}>反馈</button><button className="fc-quiet" onClick={()=>suspendCard(current)}>暂停学习</button><button className="fc-quiet" disabled={!undo} onClick={restoreRating}><RotateCcw size={15}/>撤销评分<kbd>U</kbd></button><button className="fc-quiet" disabled={(session?.queue.length || 0) < 2} onClick={skip}><SkipForward size={15}/>稍后再看<kbd>S</kbd></button></div>
          <p className="fc-study-note">{revealed ? "重来会放回本轮队列，其余评分标记今日已复习。" : "专注于眼前这一张。"}</p>
          </> : <section ref={studyRef} tabIndex={-1} className="fc-complete" aria-label="本轮复习完成"><div className="fc-complete-mark"><Check size={32}/></div><span className="fc-eyebrow">一点一点，留下积累</span><h1>这一轮，完成了。</h1><p>完成 {session?.initialIds.length || 0} 张卡片，共 {session?.ratings.length || 0} 次回忆。</p><div className="fc-complete-stats"><span><strong>{session?.ratings.filter(rating => rating >= 3).length || 0}</strong>次回忆顺畅</span><span><strong>{session?.ratings.filter(rating => rating <= 2).length || 0}</strong>次需要巩固</span></div><p className="fc-next-due">{upcoming?`下一批示例到期：${new Intl.DateTimeFormat("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"Asia/Shanghai"}).format(new Date(upcoming))}`:"暂无下一批已安排到期的示例卡片。"}</p>{waiting>0&&<button className="fc-secondary" onClick={grantExtra}>再学 {Math.min(5,waiting)} 张新卡</button>}<div className="fc-complete-actions"><button className="fc-primary" onClick={() => navigate("due")}>回到今日<ArrowRight size={16}/></button><button className="fc-secondary" onClick={() => navigate("cards")}>浏览卡片</button></div>{undo && <button className="fc-quiet" onClick={restoreRating}><RotateCcw size={14}/>撤销最后一次评分</button>}</section>}
        </div> : <div className="fc-content">
          <header className="fc-page-heading"><div><span className="fc-eyebrow">{page === "due" ? <><Sun size={15}/>每天，记住一点点</> : page === "deck" || page === "cards" ? "你的知识，随时温习" : "闪卡 · 学习空间"}</span><h1>{pageTitle}</h1><p>{page === "due" ? "重温那些，值得留下的知识。" : page === "cards" || page === "deck" ? `${scopeCards.length} 张卡片${page === "cards" ? ` · ${decks.length} 个牌组` : ` · ${decks.find(item => item.name === deck)?.description || ""}`}` : page === "stats" ? "看看过去的积累，找到自己的节奏。" : "把待确认的知识，留在一个地方。"}</p></div>{page === "due" ? <time className="fc-heading-date">{dateLabel}</time> : (page === "cards" || page === "deck") && <button className="fc-primary" disabled={!ready || (!activeSession && !plan.session.length)} onClick={() => start()}><Play size={15}/>{activeSession ? `继续 · ${session!.label}` : page === "cards" ? "复习全部卡片" : "复习这个牌组"}</button>}</header>
          <FlashcardExamples state={state} setState={setState} onReset={resetExample}/>
          {page === "due" ? <>
            <section className="fc-hero" aria-label="今日复习计划"><div className="fc-hero-copy"><span className="fc-kicker"><span className="fc-kicker-dot"/>{!cards.length?"尚无示例卡片":activeSession ? "上次的进度，已为你留好" : todayPlan.eligible.length ? `今日待学习 · ${todayPlan.eligible.length} 张` : waiting ? "放慢一点，也很好" : "今天的计划，已完成"}</span><h2>{!cards.length?<>牌库里还没有卡片。</>:activeSession ? <>接着上一次，<br/>继续记住一点。</> : todayPlan.eligible.length ? <>让读过的，<br/>变成记得的。</> : <>今天的积累，<br/>已经留下来了。</>}</h2><p>{!cards.length?"可以载入示例卡片，体验一次完整复习。":activeSession ? `${session!.label} · 还有 ${session!.queue.length} 张等你继续` : waiting && !todayPlan.eligible.length ? `${waiting} 张新卡等待额度。可只为这个示例日增加额度，每日偏好不变。` : todayPlan.eligible.length ? `${todayPlan.eligible.length - newCount} 张待温习 · ${newCount} 张新卡` : "给自己一点留白，或回看喜欢的卡片。"}</p><div className="fc-hero-actions"><button className="fc-primary" disabled={!ready} onClick={() => !cards.length?setState(makeFlashState()):activeSession || plan.session.length ? start("") : navigate("cards")}>{activeSession || plan.session.length ? <Play size={16} fill="currentColor"/> : <BookOpen size={16}/>} {activeSession || plan.session.length ? startLabel : !cards.length?"载入示例卡片":"浏览卡片"}<ArrowRight size={15}/></button><button className="fc-quiet" onClick={() => setDialog({kind: "settings"})}><Settings2 size={15}/>复习偏好</button></div><div className="fc-hero-meta"><Clock3 size={13}/><span>本轮 {activeSession?session!.queue.length:plan.session.length} 张 · 今日待学习 {todayPlan.eligible.length} 张 · {minutes?`示例约 ${minutes} 分钟`:"用时样本不足"}</span></div></div>
              {cards.length>0?<button className="fc-card-stack" onClick={() => setDialog({kind: "preview", cardId: nextCard.id,hideAnswer:true})} aria-label={`预览下一张：${nextCard.question}`}><span className="fc-stack-sheet back-two"/><span className="fc-stack-sheet back-one"/><span className="fc-stack-face"><span className="fc-stack-label"><BookOpen size={14}/>{nextCard.deck}<span>Q</span></span><strong>{nextCard.question}</strong><span className="fc-stack-bottom"><span>轻点，预览这张卡片</span><ArrowUpRight size={15}/></span></span></button>:<p className="fc-empty-stack">示例牌库为空，可先查看收件箱或重置示例。</p>}
            </section>
            {waiting>0&&<div className="fc-extra-note"><button className="fc-secondary" onClick={grantExtra}>再学 {Math.min(5,waiting)} 张新卡</button><p>额外额度只对本示例日有效，次日归零；学习计入今日新卡，不改变已保存的每日偏好。</p></div>}
            {metrics}
            <div className="fc-dashboard-bottom"><section><div className="fc-section-heading"><h2>我的牌组 <span>{decks.length}</span></h2><button className="fc-quiet" onClick={() => navigate("cards")}>查看全部<ChevronRight size={14}/></button></div><div className="fc-deck-tiles">{decks.map(({name, description, tone, Icon}) => {const all = cards.filter(card => card.deck === name); const due = todayPlan.eligible.filter(card => card.deck === name).length; return <div className="fc-deck-tile-row" key={name}><button className="fc-deck-tile" onClick={() => navigate("deck", name)}><span className="fc-deck-icon" data-tone={tone}><Icon size={22}/></span><span className="fc-deck-copy"><strong>{name}</strong><small>{description}</small></span><span className="fc-deck-count"><strong>{due ? `${due} 待复习` : "已完成"}</strong><small>共 {all.length} 张</small></span><ChevronRight size={15}/></button><button className="fc-secondary fc-deck-start" disabled={!activeSession&&!planForState(state,state.sessionLimit,name).session.length} onClick={()=>start(name)}>{activeSession?"继续当前一轮":"开始复习"}</button></div>;})}</div></section>{rhythm}</div><FlashcardFuture state={state}/>
          </> : page === "stats" ? <>{metrics}<div className="fc-stats-rhythm">{rhythm}</div><FlashcardFuture state={state}/><section className="fc-stats-status"><div className="fc-section-heading"><h2>卡片状态</h2><button className="fc-quiet" onClick={() => navigate("cards")}>查看牌库<ChevronRight size={14}/></button></div><div className="fc-metrics">{(["due", "new", "done"] as const).map(status => <button className="fc-metric fc-metric-link" key={status} onClick={() => {navigate("cards"); setFilter(status);}}><span className="fc-metric-label">{statusNames[status]}</span><div><strong>{cards.filter(card => getFlashCardStatus(card, state) === status).length}</strong><small>张</small></div></button>)}</div></section></>
          : page === "inbox" ? <FlashcardDrafts state={state} setState={setState}/>
          : <><div className="fc-library-toolbar"><label className="fc-library-search"><Search size={17}/><input ref={searchRef} aria-label="搜索卡片内容" placeholder="搜索问题、答案或来源…" value={query} onChange={event => setQuery(event.target.value)}/>{query ? <button className="fc-icon-button" aria-label="清除卡片搜索" onClick={() => {setQuery(""); searchRef.current?.focus();}}><X size={14}/></button> : <kbd>/</kbd>}</label><div className="fc-layout-switch" role="group" aria-label="卡片显示方式"><button className={layout === "grid" ? "active" : ""} aria-label="卡片网格" aria-pressed={layout === "grid"} onClick={() => setLayout("grid")}><LayoutGrid size={17}/></button><button className={layout === "list" ? "active" : ""} aria-label="卡片列表" aria-pressed={layout === "list"} onClick={() => setLayout("list")}><List size={18}/></button></div></div>
            <div className="fc-filters" role="group" aria-label="按卡片状态筛选">{(["all", "due", "new", "done", "suspended"] as Filter[]).map(status => <button className={filter === status ? "active" : ""} aria-pressed={filter === status} key={status} onClick={() => setFilter(status)}>{status === "all" ? "全部" : statusNames[status]}<span>{scopeCards.filter(card => status === "all" || getFlashCardStatus(card, state) === status).length}</span></button>)}<small>{filtered.length} 张卡片</small></div>
            {filtered.length ? <div className={layout === "grid" ? "fc-card-grid" : "fc-card-list"}>{filtered.map(card => <button key={card.id} className="fc-library-card" aria-label={`预览卡片：${card.question}`} aria-haspopup="dialog" onClick={() => setDialog({kind: "preview", cardId: card.id})}><span className="fc-card-top"><span><BookOpen size={14}/>{card.deck}</span>{cardBadge(card)}</span><h3>{card.question}</h3><span className="fc-card-bottom"><span><Link2 size={12}/>{card.source}</span><ArrowRight size={15}/></span></button>)}</div> : <div className="fc-empty"><Search size={30}/><h2>暂时没有匹配的卡片</h2><p>试试其他关键词，或清除筛选条件。</p><button className="fc-secondary" onClick={() => {setQuery(""); setFilter("all");}}>清除搜索与筛选</button></div>}
          </>}
        </div>}
      </div>
    </div>

    {dialog && <div className="fc-overlay" onMouseDown={event => {if (event.target === event.currentTarget) setDialog(null);}}><div ref={dialogRef} className={previewCard ? "fc-drawer" : "fc-dialog"} role="dialog" aria-modal="true" aria-label={previewCard ? "卡片预览" : dialog.kind==="edit"?"编辑示例卡片":dialog.kind==="feedback"?"示例反馈":dialog.kind === "settings" ? "复习偏好" : dialog.kind === "help" ? "键盘快捷键" : "关于闪卡"}>
      <header><span>{previewCard ? "卡片预览" : dialog.kind==="edit"?"编辑示例卡片":dialog.kind==="feedback"?"示例反馈":dialog.kind === "settings" ? "复习偏好" : dialog.kind === "help" ? "键盘快捷键" : "关于闪卡"}</span><div>{previewCard && <><button className="fc-icon-button" aria-label="预览上一张" disabled={previewIndex <= 0} onClick={() => setDialog({kind: "preview", cardId: previewPool[previewIndex - 1].id,hideAnswer:dialog.kind==="preview"&&dialog.hideAnswer})}><ChevronLeft size={18}/></button><button className="fc-icon-button" aria-label="预览下一张" disabled={previewIndex >= previewPool.length - 1} onClick={() => setDialog({kind: "preview", cardId: previewPool[previewIndex + 1].id,hideAnswer:dialog.kind==="preview"&&dialog.hideAnswer})}><ChevronRight size={18}/></button></>}<button className="fc-icon-button" data-initial-focus aria-label="关闭弹层" onClick={() => setDialog(null)}><X size={18}/></button></div></header>
      {previewCard ? <><div className="fc-dialog-body fc-preview-content"><div className="fc-preview-meta"><span><Layers3 size={15}/>{previewCard.deck}</span>{cardBadge(previewCard)}</div><span className="fc-question-label">问题</span><h2>{previewCard.question}</h2>{dialog.kind!=="preview"||!dialog.hideAnswer||previewRevealed?<div className="fc-preview-answer"><span className="fc-answer-label"><Check size={14}/>参考答案</span><p>{previewCard.answer}</p></div>:<button className="fc-secondary" onClick={()=>setPreviewRevealed(true)}>显示参考答案</button>}<div className="fc-preview-source"><Link2 size={16}/><div><small>卡片来源</small><p>{previewCard.source}</p></div></div><dl className="fc-preview-properties"><div><dt>题型</dt><dd>{typeLabel(previewCard)}</dd></div><div><dt>牌组</dt><dd>{previewCard.deck}</dd></div><div><dt>状态</dt><dd>{statusNames[getFlashCardStatus(previewCard, state)]}</dd></div></dl></div><div className="fc-dialog-footer"><button className="fc-quiet" onClick={()=>editCard(previewCard)}>编辑</button><button className="fc-quiet" onClick={()=>suspendCard(previewCard)}>{state.suspended.includes(previewCard.id)?"恢复学习":"暂停学习"}</button></div><footer className="fc-dialog-footer"><span>{previewIndex + 1} / {previewPool.length}</span><button className="fc-primary" disabled={!activeSession && !planForState(state,state.sessionLimit,previewCard.deck).session.length} onClick={() => start(previewCard.deck)}><Play size={15}/>{activeSession ? `继续 · ${session!.label}` : "复习这个牌组"}</button></footer></>
      : dialog.kind==="edit"?<><div className="fc-dialog-body fc-edit-fields"><p>仅编辑本浏览器的示例问题与参考说明；客观题的固定判定答案保持不变。</p><label>问题<textarea aria-label="编辑示例问题" maxLength={5000} value={editQuestion} onChange={e=>setEditQuestion(e.target.value)}/></label><label>参考说明<textarea aria-label="编辑示例答案" maxLength={10000} value={editAnswer} onChange={e=>setEditAnswer(e.target.value)}/></label></div><footer className="fc-dialog-footer"><button className="fc-primary" disabled={!editQuestion.trim()||!editAnswer.trim()} onClick={()=>{setState(s=>({...s,edits:{...s.edits,[dialog.cardId]:{question:editQuestion.trim(),answer:editAnswer.trim()}}}));setDialog(null);setNotice("已保存示例编辑");}}>保存示例编辑</button></footer></>
      : dialog.kind==="feedback"?<><div className="fc-dialog-body fc-edit-fields"><p>反馈仅保存在本浏览器，不向真实制卡服务发送。</p><label>反馈说明<textarea aria-label="示例反馈说明" value={feedback} maxLength={1000} onChange={e=>setFeedback(e.target.value)}/></label></div><footer className="fc-dialog-footer"><button className="fc-primary" disabled={!feedback.trim()} onClick={()=>{setState(s=>({...s,feedback:[...s.feedback,{cardId:dialog.cardId,note:feedback.trim()}].slice(-50)}));setDialog(null);setNotice("示例反馈已保留");}}>保存示例反馈</button></footer></>
      : dialog.kind === "settings" ? <><div className="fc-dialog-body"><p className="fc-dialog-intro">选一个轻松、可持续的节奏。</p><label className="fc-settings-row"><span><strong>本次复习张数</strong><small>开始下一轮时生效</small></span><select aria-label="本次复习张数" value={state.sessionLimit} onChange={event => updatePreference("sessionLimit", Number(event.target.value))}>{sessionLimits.map(value => <option key={value} value={value}>{value ? `${value} 张` : "全部"}</option>)}</select></label><label className="fc-settings-row"><span><strong>每天新卡额度</strong><small>已学习过的卡片不受此额度限制</small></span><select aria-label="每日新卡额度" value={state.dailyLimit} onChange={event => updatePreference("dailyLimit", Number(event.target.value))}>{dailyLimits.map(value => <option key={value} value={value}>{value ? `${value} 张` : "不限"}</option>)}</select></label><div className="fc-settings-summary"><Clock3 size={17}/><span>今天已学习 {state.newToday} 张新卡。{state.dailyLimit ? `还可学习 ${Math.max(0, effectiveNewLimit(state) - state.newToday)} 张。` : "当前不限制新卡数量。"}</span></div>{activeSession && <div className="fc-settings-row"><span><strong>当前复习</strong><small>{session!.label} · 剩余 {session!.queue.length} 张</small></span><button className="fc-secondary" onClick={() => {setState(previous => ({...previous, session: null})); setUndo(null); setReviewing(false); setNotice("已结束本轮，已完成的评分会保留");}}>重新安排</button></div>}<p className="fc-dialog-footnote">偏好与复习进度保存在本浏览器。此处为示例复习，尚未接入完整的间隔调度。</p></div><footer className="fc-dialog-footer"><span><Check size={14}/>{storageOk ? "已自动保存" : "浏览器暂不支持保存"}</span><button className="fc-primary" onClick={() => setDialog(null)}>完成</button></footer></>
      : dialog.kind === "help" ? <><div className="fc-dialog-body"><p className="fc-dialog-intro">双手留在键盘，也能轻松复习。</p><dl className="fc-shortcut-list">{[["/", "搜索卡片"], ["Space", "显示答案"], ["1 — 4", "选择回忆程度"], ["S", "稍后再看"], ["U", "撤销上一张评分"], ["Esc", "暂停复习 / 关闭弹层"]].map(([key, value]) => <div key={key}><dt>{value}</dt><dd><kbd>{key}</kbd></dd></div>)}</dl><p className="fc-dialog-footnote">输入文字时不会触发复习快捷键。Ctrl / ⌘ K 也可搜索卡片。</p></div><footer className="fc-dialog-footer"><span><Command size={14}/>按自己的方式操作</span><button className="fc-primary" onClick={() => setDialog(null)}>知道了</button></footer></>
      : <><div className="fc-dialog-body"><div className="fc-about-icon"><BookOpenCheck size={28}/></div><h2>把知识，慢慢留下来。</h2><p className="fc-dialog-intro">这是 Hub 闪卡的交互原型。卡片与历史学习记录为示例数据，你的复习操作与偏好保存在当前浏览器。</p><p className="fc-dialog-footnote">当前支持卡片浏览、搜索筛选、四档评分、撤销、暂停与继续。评分暂未连接真实的间隔重复算法、云同步或外部制卡服务。</p></div><footer className="fc-dialog-footer"><span>Hub · 闪卡</span><button className="fc-primary" onClick={() => setDialog(null)}>继续探索</button></footer></>}
    </div></div>}
    {notice && <div className="fc-toast" role="status"><Check size={15}/>{notice}</div>}
  </section>;
}

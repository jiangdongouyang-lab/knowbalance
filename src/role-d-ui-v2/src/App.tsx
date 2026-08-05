import {
  ArrowRight,
  BookOpen,
  Bot,
  Braces,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleHelp,
  Clock3,
  Code2,
  ExternalLink,
  FileText,
  FlaskConical,
  FolderTree,
  GraduationCap,
  History,
  Home,
  Layers3,
  Lightbulb,
  ListChecks,
  Menu,
  MessageCircleQuestion,
  Pause,
  Play,
  RotateCcw,
  ShieldCheck,
  Sparkles,
  Target,
  UserRound,
  X,
} from "lucide-react"
import { createContext, useContext, useEffect, useMemo, useState } from "react"
import { PYTHON_CURRICULUM } from "./curriculum"
import {
  createOrchestratorSession,
  getOrchestratorEvents,
  getOrchestratorSession,
  retryOrchestratorSession,
  submitAssessmentAnswers,
  submitDiagnosisAnswers,
} from "./orchestrator-client"
import { answersToSubmission, assessmentComplete, diagnosisComplete, pageForSession } from "./orchestrator-view"
import type { AssessmentPayload, Citation, CodeLabPayload, LessonPayload, PublicSessionFixture } from "./types"

const SESSION_STORAGE_KEY = "knowbalance-v3-orchestrator-session"
const LEARNER_STORAGE_KEY = "knowbalance-v2-learner-id"
const DEFAULT_LEARNER_ID = "learner-role-d-demo"

type LiveContextValue = {
  session: PublicSessionFixture | null
  isLive: boolean
  learnerId: string
  busy: string
  error: string
  diagnosisAnswers: Record<string, string>
  assessmentAnswers: Record<string, string>
  setDiagnosisAnswer: (itemId: string, answer: string) => void
  setAssessmentAnswer: (itemId: string, answer: string) => void
  create: (input: { goal: string; nodeId?: string; custom?: boolean }) => Promise<void>
  submitDiagnosis: () => Promise<void>
  submitAssessment: () => Promise<void>
  retry: () => Promise<void>
  refreshEvents: () => Promise<void>
  reset: () => void
}

const LiveContext = createContext<LiveContextValue | null>(null)

function useLive() {
  const value = useContext(LiveContext)
  if (!value) throw new Error("LiveContext is not available")
  return value
}

function useRequiredSession() {
  const { session } = useLive()
  if (!session) throw new Error("This page requires an active orchestrator session")
  return session
}

type Page = "home" | "goal" | "diagnosis" | "path" | "lesson" | "assessment" | "feedback" | "history"
type LessonTab = "lesson" | "lab" | "checks"
type SideTab = "hint" | "evidence" | "agents"

const navItems: Array<{ id: Page; label: string; icon: typeof Home }> = [
  { id: "home", label: "首页", icon: Home },
  { id: "goal", label: "新建学习", icon: Target },
  { id: "path", label: "学习方案", icon: FolderTree },
  { id: "lesson", label: "互动学习", icon: BookOpen },
  { id: "assessment", label: "正式测评", icon: ListChecks },
  { id: "feedback", label: "学习反馈", icon: Sparkles },
  { id: "history", label: "学习记录", icon: History },
]

export function App() {
  const learnerId = useMemo(() => localStorage.getItem(LEARNER_STORAGE_KEY) || DEFAULT_LEARNER_ID, [])
  const [liveSession, setLiveSession] = useState<PublicSessionFixture | null>(null)
  const [page, setPage] = useState<Page>(() => localStorage.getItem(SESSION_STORAGE_KEY) ? "home" : "goal")
  const [menuOpen, setMenuOpen] = useState(false)
  const [motionOn, setMotionOn] = useState(true)
  const [scrollProgress, setScrollProgress] = useState(0)
  const [busy, setBusy] = useState("")
  const [error, setError] = useState("")
  const [diagnosisAnswers, setDiagnosisAnswers] = useState<Record<string, string>>({})
  const [assessmentAnswers, setAssessmentAnswers] = useState<Record<string, string>>({})

  const applySession = (next: any) => {
    const merged = { ...next, events: Array.isArray(next.events) ? next.events : [] } as PublicSessionFixture
    setLiveSession(merged)
    localStorage.setItem(SESSION_STORAGE_KEY, merged.session_id)
    localStorage.setItem(LEARNER_STORAGE_KEY, learnerId)
    setPage(pageForSession(merged))
    setError("")
  }

  useEffect(() => {
    const sessionId = localStorage.getItem(SESSION_STORAGE_KEY)
    if (!sessionId) return
    let cancelled = false
    setBusy("正在恢复主 Agent会话…")
    getOrchestratorSession(sessionId, learnerId)
      .then(async (restored) => {
        if (cancelled) return
        const eventResult = await getOrchestratorEvents(sessionId, learnerId).catch(() => ({ events: [] }))
        applySession({ ...restored, events: eventResult.events ?? [] })
      })
      .catch((reason) => {
        if (!cancelled) {
          localStorage.removeItem(SESSION_STORAGE_KEY)
          setError(reason instanceof Error ? reason.message : "无法恢复会话")
        }
      })
      .finally(() => { if (!cancelled) setBusy("") })
    return () => { cancelled = true }
  }, [learnerId])

  useEffect(() => {
    const update = () => {
      const max = document.documentElement.scrollHeight - window.innerHeight
      setScrollProgress(max <= 0 ? 0 : Math.min(1, window.scrollY / max))
    }
    update()
    window.addEventListener("scroll", update, { passive: true })
    return () => window.removeEventListener("scroll", update)
  }, [page])

  const liveValue: LiveContextValue = {
    session: liveSession,
    isLive: Boolean(liveSession),
    learnerId,
    busy,
    error,
    diagnosisAnswers,
    assessmentAnswers,
    setDiagnosisAnswer: (itemId, answer) => setDiagnosisAnswers((current) => ({ ...current, [itemId]: answer })),
    setAssessmentAnswer: (itemId, answer) => setAssessmentAnswers((current) => ({ ...current, [itemId]: answer })),
    create: async ({ goal, nodeId, custom }) => {
      setBusy("主 Agent正在创建会话并选择客观诊断题…")
      setError("")
      try {
        const created = await createOrchestratorSession({
          learnerId,
          goal,
          learningGoalSpec: custom
            ? { mode: "custom_goal", custom_goal: goal }
            : { mode: "curriculum_node", selected_node_ids: nodeId ? [nodeId] : [] },
        })
        applySession(created)
        setDiagnosisAnswers({})
        setAssessmentAnswers({})
      } catch (reason) {
        setError(reason instanceof Error ? reason.message : "创建主 Agent会话失败")
      } finally { setBusy("") }
    },
    submitDiagnosis: async () => {
      if (!liveSession || !diagnosisComplete(liveSession, diagnosisAnswers)) return
      setBusy("主 Agent正在生成画像、路径、RAG与 C 学习资源…")
      setError("")
      try {
        const next = await submitDiagnosisAnswers(liveSession.session_id, learnerId, diagnosisAnswers)
        const eventResult = await getOrchestratorEvents(liveSession.session_id, learnerId).catch(() => ({ events: [] }))
        applySession({ ...next, events: eventResult.events ?? [] })
        setAssessmentAnswers({})
      } catch (reason) { setError(reason instanceof Error ? reason.message : "提交诊断失败") }
      finally { setBusy("") }
    },
    submitAssessment: async () => {
      if (!liveSession || !assessmentComplete(liveSession, assessmentAnswers)) return
      setBusy("Role C正在正式评分并由主 Agent决定下一步…")
      setError("")
      try {
        const next = await submitAssessmentAnswers(liveSession.session_id, learnerId, answersToSubmission(liveSession.assessment?.payload?.items ?? [], assessmentAnswers))
        const eventResult = await getOrchestratorEvents(liveSession.session_id, learnerId).catch(() => ({ events: [] }))
        applySession({ ...next, events: eventResult.events ?? [] })
        setAssessmentAnswers({})
      } catch (reason) { setError(reason instanceof Error ? reason.message : "提交正式测评失败") }
      finally { setBusy("") }
    },
    retry: async () => {
      if (!liveSession) return
      setBusy("主 Agent正在从持久化检查点重试…")
      setError("")
      try { applySession(await retryOrchestratorSession(liveSession.session_id, learnerId)) }
      catch (reason) { setError(reason instanceof Error ? reason.message : "重试失败") }
      finally { setBusy("") }
    },
    refreshEvents: async () => {
      if (!liveSession) return
      const result = await getOrchestratorEvents(liveSession.session_id, learnerId)
      setLiveSession((current) => current ? { ...current, events: result.events ?? [] } : current)
    },
    reset: () => {
      localStorage.removeItem(SESSION_STORAGE_KEY)
      setLiveSession(null)
      setDiagnosisAnswers({})
      setAssessmentAnswers({})
      setError("")
      setPage("goal")
    },
  }

  return (
    <LiveContext.Provider value={liveValue}>
    <div className={`app-shell${motionOn ? " motion-on" : " motion-off"}`}>
      <div className="reading-progress" aria-hidden="true"><span style={{ transform: `scaleX(${scrollProgress})` }} /></div>
      <Atmosphere />
      <div className="utility-bar">
        <span>Python 个性化学习空间</span>
        <span><ShieldCheck size={14} /> {liveSession ? `主 Agent实时会话 · ${liveSession.session_id}` : "尚未创建主 Agent会话"}</span>
      </div>
      <header className="topbar">
        <button className="brand" type="button" onClick={() => setPage("home")}>
          <span className="brand-mark"><Layers3 size={22} /></span>
          <span><b>KnowBalance</b><small>让每一步学习都有依据</small></span>
        </button>
        <nav className="primary-nav" aria-label="主导航">
          {navItems.slice(0, 5).map((item) => <NavButton item={item} current={page} disabled={!liveSession && item.id !== "goal" && item.id !== "home"} onClick={setPage} key={item.id} />)}
        </nav>
        <div className="top-actions">
          {liveSession && <span className="save-state"><CheckCircle2 size={15} /> 服务端已保存</span>}
          <button className={`motion-toggle${motionOn ? " is-on" : ""}`} type="button" aria-pressed={motionOn} onClick={() => setMotionOn((value) => !value)}><Sparkles size={15} /> {motionOn ? "动态开启" : "动态关闭"}</button>
          {liveSession && <button className="continue-button" type="button" onClick={() => setPage(pageForSession(liveSession))}>继续学习 <ArrowRight size={16} /></button>}
          <button className="avatar-button" type="button" aria-label="学习者账户"><UserRound size={18} /></button>
          <button className="menu-button" type="button" aria-label="打开菜单" onClick={() => setMenuOpen(true)}><Menu size={21} /></button>
        </div>
      </header>
      {menuOpen && <MobileMenu current={page} hasSession={Boolean(liveSession)} onClose={() => setMenuOpen(false)} onSelect={(next) => { setPage(next); setMenuOpen(false) }} />}
      {busy && <div className="live-operation" role="status"><span className="operation-spinner" />{busy}</div>}
      {error && <div className="live-error" role="alert"><b>主 Agent请求未完成</b><span>{error}</span><button type="button" onClick={() => setPage("goal")}>返回新建学习</button></div>}
      <main>
        {page === "home" && <HomePage onStart={() => setPage("goal")} onContinue={() => liveSession && setPage(pageForSession(liveSession))} />}
        {page === "goal" && <GoalPage onContinue={() => setPage("diagnosis")} />}
        {page === "diagnosis" && (liveSession ? <DiagnosisPage onContinue={() => setPage("path")} /> : <NoSessionState onStart={() => setPage("goal")} />)}
        {page === "path" && (liveSession ? <PathPage onContinue={() => setPage("lesson")} /> : <NoSessionState onStart={() => setPage("goal")} />)}
        {page === "lesson" && (liveSession ? <LessonPage onAssessment={() => setPage("assessment")} /> : <NoSessionState onStart={() => setPage("goal")} />)}
        {page === "assessment" && (liveSession ? <AssessmentPage onFeedback={() => setPage("feedback")} /> : <NoSessionState onStart={() => setPage("goal")} />)}
        {page === "feedback" && (liveSession ? <FeedbackPage onContinue={() => setPage(pageForSession(liveSession))} /> : <NoSessionState onStart={() => setPage("goal")} />)}
        {page === "history" && (liveSession ? <HistoryPage /> : <NoSessionState onStart={() => setPage("goal")} />)}
      </main>
    </div>
    </LiveContext.Provider>
  )
}

function Atmosphere() {
  return <div className="ambient-layer" aria-hidden="true"><span className="ambient-blob blob-blue" /><span className="ambient-blob blob-mint" /><span className="ambient-blob blob-gold" /><span className="ambient-grid" /><div className="learning-constellation"><i className="constellation-line line-a" /><i className="constellation-line line-b" /><b className="constellation-node node-main">M</b><b className="constellation-node node-a">A</b><b className="constellation-node node-b">B</b><b className="constellation-node node-c">C</b></div></div>
}

function NavButton({ item, current, onClick, disabled = false }: { item: (typeof navItems)[number]; current: Page; onClick: (page: Page) => void; disabled?: boolean }) {
  const Icon = item.icon
  return <button className={current === item.id ? "is-active" : ""} disabled={disabled} type="button" onClick={() => onClick(item.id)}><Icon size={16} />{item.label}</button>
}

function MobileMenu({ current, hasSession, onClose, onSelect }: { current: Page; hasSession: boolean; onClose: () => void; onSelect: (page: Page) => void }) {
  return <div className="mobile-menu-backdrop" onClick={onClose}><aside className="mobile-menu" onClick={(event) => event.stopPropagation()}><div className="mobile-menu-head"><b>页面导航</b><button onClick={onClose} type="button"><X /></button></div>{navItems.map((item) => <NavButton item={item} current={current} disabled={!hasSession && item.id !== "goal" && item.id !== "home"} onClick={onSelect} key={item.id} />)}</aside></div>
}

function HomePage({ onStart, onContinue }: { onStart: () => void; onContinue: () => void }) {
  const { session: activeSession, reset } = useLive()
  if (!activeSession) return <div className="page page-home"><section className="welcome-strip"><div><span className="eyebrow"><Sparkles size={15} /> 尚未开始学习</span><h1>创建主 Agent会话，开始真实流程。</h1><p>D 不展示任何预置画像、路径、讲义、评分或 Worker状态。创建会话后，所有业务内容只来自主 Agent公开响应。</p><div className="hero-actions"><button className="primary-action" type="button" onClick={onStart}>新建真实学习会话 <ArrowRight /></button></div></div><div className="soft-orbit" aria-hidden="true"><span className="orbit-core"><GraduationCap /></span></div></section></div>
  return <div className="page page-home">
    <section className="welcome-strip">
      <div><span className="eyebrow"><Sparkles size={15} /> 主 Agent实时会话</span><h1>继续你的个性化学习。</h1><p>历史画像、学习路径和正式测评结果由主 Agent统一保存。新版 D 只负责帮助你看懂并完成当前任务。</p><div className="hero-actions"><button className="primary-action" type="button" onClick={onContinue}>继续当前学习 <ArrowRight /></button><button className="secondary-action" type="button" onClick={reset}>结束本地会话并新建</button></div></div>
      <div className="soft-orbit" aria-hidden="true"><span className="orbit-core"><GraduationCap /></span><span className="orbit-dot dot-one">A</span><span className="orbit-dot dot-two">B</span><span className="orbit-dot dot-three">C</span></div>
    </section>
    <section className="home-grid">
      <article className="continue-card"><div className="card-kicker"><BookOpen size={16} /> 当前会话</div><h2>{activeSession.current_path_node?.goal ?? activeSession.profile?.goal ?? diagnosisGateLabel(activeSession)}</h2><div className="path-chips"><span>第 {activeSession.round_no} 轮</span>{activeSession.profile?.level && <span>{activeSession.profile.level}</span>}<span>{activeSession.status === "waiting_for_user" ? waitingLabel(activeSession.waiting_for?.type) : activeSession.status}</span></div><div className="continue-meta"><span>{stageLabel(activeSession)}</span><b>revision {activeSession.revision ?? "--"}</b></div><button type="button" onClick={onContinue}>进入当前阶段 <ArrowRight size={17} /></button></article>
      <article className="compact-card"><div className="card-kicker"><Target size={16} /> 学习目标</div><h3>{activeSession.profile?.goal ?? activeSession.current_path_node?.goal ?? "诊断完成后由主 Agent生成画像"}</h3><p>目标与后续路径来自本次主 Agent会话。</p></article>
      <article className="compact-card mint"><div className="card-kicker"><CheckCircle2 size={16} /> 历史状态</div><h3>{activeSession.profile ? `${activeSession.profile.known_concepts?.length ?? 0} 个已掌握知识` : "等待画像生成"}</h3><p>{activeSession.profile ? `薄弱知识：${activeSession.profile.weak_concepts?.join("、") || "暂无公开结果"}` : "D 不预先声称历史读取结果。"}</p></article>
      <article className="compact-card lilac"><div className="card-kicker"><Bot size={16} /> Agent协同</div><h3>{activeSession.worker_ledger.filter((item) => item.status === "completed").length} / {activeSession.worker_ledger.length} 已完成</h3><p>默认保持安静，评委或学习者需要时再展开真实事件。</p></article>
    </section>
  </div>
}

function GoalPage({ onContinue: _onContinue }: { onContinue: () => void }) {
  const { create, busy } = useLive()
  const chapters = PYTHON_CURRICULUM
  const [mode, setMode] = useState<"catalog" | "custom">("catalog")
  const [selected, setSelected] = useState("PY-CH02-S02")
  const [customGoal, setCustomGoal] = useState("我想学会用循环和列表完成一个成绩统计程序")
  const selectedTopic = chapters.flatMap((chapter) => chapter.topics).find((topic) => topic.node_id === selected)
  return <div className="page narrow-page"><PageHeading kicker="建立学习目标" title="这次，你想真正学会什么？" description="课程目录来自仓库中的 Python curriculum；也可以保留自定义目标模式。历史学习情况由主 Agent读取，不再要求你重复填写。" />
    <div className="segmented"><button className={mode === "catalog" ? "is-active" : ""} onClick={() => setMode("catalog")} type="button">从课程目录选择</button><button className={mode === "custom" ? "is-active" : ""} onClick={() => setMode("custom")} type="button">自定义学习目标</button></div>
    {mode === "catalog" ? <div className="chapter-grid">{chapters.map((chapter) => <article className={`chapter-card ${chapter.tone}`} key={chapter.node_id}><h2>{chapter.title}</h2>{chapter.topics.map((topic) => <button className={selected === topic.node_id ? "is-selected" : ""} type="button" key={topic.node_id} onClick={() => setSelected(topic.node_id)}><span>{topic.title}</span>{selected === topic.node_id && <Check size={16} />}</button>)}</article>)}</div> : <article className="custom-goal-card"><label htmlFor="custom-goal">用自己的话描述学习目标</label><textarea id="custom-goal" value={customGoal} onChange={(event) => setCustomGoal(event.target.value)} /><p>主 Agent会把自定义描述映射到真实课程知识与题库；D 不在本地推断结果。</p></article>}
    <div className="history-read-card"><div className="history-icon"><History /></div><div><b>历史学习情况由主 Agent处理</b><p>D 不要求用户手动填写薄弱知识，也不预先声称历史已经读取；画像生成后再展示主 Agent公开结果。</p></div><span>服务端负责</span></div>
    <div className="page-actions"><button className="primary-action" disabled={Boolean(busy) || (mode === "custom" ? customGoal.trim().length === 0 : !selectedTopic)} type="button" onClick={() => void create(mode === "custom" ? { goal: customGoal.trim(), custom: true } : { goal: `学习${selectedTopic?.title ?? "Python基础"}`, nodeId: selectedTopic?.node_id })}>{busy ? "正在创建会话…" : "确认目标并创建主 Agent会话"} <ArrowRight /></button></div>
  </div>
}

function DiagnosisPage({ onContinue: _onContinue }: { onContinue: () => void }) {
  const { isLive, diagnosisAnswers: liveAnswers, setDiagnosisAnswer, submitDiagnosis, busy } = useLive()
  const activeSession = useRequiredSession()
  const items = activeSession.waiting_for?.type === "diagnosis_answers" ? activeSession.waiting_for.items as any[] : []
  const previewItems = items
  const [index, setIndex] = useState(0)
  const answers = isLive ? liveAnswers : {}
  const item = previewItems[index]
  if (!item) return <EmptyState title="当前合同样例没有公开题目" body="D 不会为了页面完整而自造诊断题。正式接入后由主 Agent返回 A 题库中的公开题目。" />
  return <div className="page diagnosis-page"><PageHeading kicker="客观诊断 · 主 Agent实时题目" title="一次只回答一个问题" description="题目由主 Agent基于学习目标、历史与 A 题库动态选择；D 只展示公开题干和来源。" />
    <section className="diagnosis-shell"><div className="diagnosis-progress"><span>问题 {index + 1} / {previewItems.length}</span><div><i style={{ width: `${((index + 1) / previewItems.length) * 100}%` }} /></div><b>{Math.round(((index + 1) / previewItems.length) * 100)}%</b></div><article className="question-card"><div className="question-meta"><span>{item.difficulty ?? "诊断题"}</span><span>{item.concept}</span><span>{item.source_id}</span></div><h2>{item.question}</h2>{item.options?.length ? <div className="diagnosis-options">{item.options.map((option: string, optionIndex: number) => <button type="button" className={answers[item.item_id] === option ? "is-selected" : ""} onClick={() => setDiagnosisAnswer(item.item_id, option)} key={`${optionIndex}-${option}`}><span>{String.fromCharCode(65 + optionIndex)}</span><b>{option}</b>{answers[item.item_id] === option && <Check size={18} />}</button>)}</div> : <textarea placeholder="写下你的回答" value={answers[item.item_id] ?? ""} onChange={(event) => setDiagnosisAnswer(item.item_id, event.target.value)} />}
      <details className="why-question"><summary><CircleHelp size={16} /> 为什么问我这道题？</summary><p>用于诊断：{item.concept}。题目来源：{item.source_id}{item.fact_id ? ` / ${item.fact_id}` : ""}。D 不在浏览器中保存答案键。</p></details></article>
      <div className="diagnosis-actions"><button className="secondary-action" disabled={index === 0} type="button" onClick={() => setIndex((value) => value - 1)}><ChevronLeft /> 上一题</button>{index < previewItems.length - 1 ? <button className="primary-action" disabled={!answers[item.item_id]} type="button" onClick={() => setIndex((value) => value + 1)}>下一题 <ChevronRight /></button> : <button className="primary-action" disabled={Boolean(busy) || !diagnosisComplete(activeSession, answers)} type="button" onClick={() => void submitDiagnosis()}>{busy ? "正在生成学习资源…" : "提交诊断并生成学习方案"} <ArrowRight /></button>}</div></section>
  </div>
}

function PathPage({ onContinue }: { onContinue: () => void }) {
  const activeSession = useRequiredSession()
  const objectives = activeSession.current_path_node?.objectives ?? []
  return <div className="page path-page"><PageHeading kicker="个性化学习方案" title={activeSession.current_path_node?.goal ?? "当前学习路径"} description="节点、目标、知识来源和观察行为均来自主 Agent公开状态。D 只负责把它们组织成学生易懂的页面。" />
    <section className="plan-overview"><div className="plan-current"><span>当前学习节点</span><h2>{activeSession.current_path_node?.node_id}</h2><p>{activeSession.current_path_node?.goal}</p><button className="primary-action" type="button" onClick={onContinue}>进入互动讲义 <ArrowRight /></button></div><div className="objective-list">{objectives.map((objective, index) => <article key={objective.objective_id}><span>{String(index + 1).padStart(2, "0")}</span><div><b>{objective.objective_id} · {behaviorLabel(objective.observable_behavior)}</b><p>来源 {objective.source_id} · 事实 {objective.required_fact_ids.join("、")} · {objective.importance}</p></div></article>)}</div></section>
    <section className="provenance-note"><ShieldCheck /><div><b>这不是 D 自行规划的路线</b><p>本页只展示主 Agent持久化的 formal_path 与 current_path_node；若上游没有公开方案，页面只显示缺失或阻塞状态。</p></div></section>
  </div>
}

function LessonPage({ onAssessment }: { onAssessment: () => void }) {
  const activeSession = useRequiredSession()
  const lesson = activeSession.learning_resources.concept_lesson?.payload
  const lab = activeSession.learning_resources.code_lab?.payload
  const [tab, setTab] = useState<LessonTab>("lesson")
  const [sideTab, setSideTab] = useState<SideTab>("hint")
  const [activeSection, setActiveSection] = useState("prerequisite")
  const [code, setCode] = useState(lab?.starter_code ?? "")
  const sections = lesson ? lessonOutline(lesson) : []
  return <div className="lesson-page"><header className="lesson-topline"><div><span className="eyebrow"><BookOpen size={15} /> 第 {activeSession.round_no} 轮学习</span><h1>{lesson?.title ?? "当前没有可发布的 C 讲义"}</h1><p>{activeSession.current_path_node?.node_id} · {lesson?.objective_ids.join(" / ")}</p></div><div className="lesson-top-actions"><span><CheckCircle2 size={15} /> 主 Agent已发布公开学习资源</span><button type="button" onClick={onAssessment}>进入正式测评 <ArrowRight /></button></div></header>
    <div className="lesson-layout">
      <aside className="lesson-outline"><div className="outline-head"><FolderTree size={18} /><b>本节目录</b></div>{sections.map((section, index) => <button className={activeSection === section.id ? "is-active" : ""} type="button" onClick={() => { setActiveSection(section.id); document.getElementById(`section-${section.id}`)?.scrollIntoView({ behavior: "smooth", block: "start" }) }} key={section.id}><span>{String(index + 1).padStart(2, "0")}</span><b>{section.title}</b></button>)}<div className="outline-progress"><span>当前内容结构</span><div><i style={{ width: "58%" }} /></div><small>由 C 公开字段直接渲染</small></div></aside>
      <section className="lesson-main"><div className="lesson-tabs" role="tablist"><span className={`tab-glider glider-${tab}`} aria-hidden="true" /><button className={tab === "lesson" ? "is-active" : ""} type="button" onClick={() => setTab("lesson")}><BookOpen size={17} /> 定制讲义</button><button className={tab === "lab" ? "is-active" : ""} type="button" onClick={() => setTab("lab")}><Code2 size={17} /> 代码实验</button><button className={tab === "checks" ? "is-active" : ""} type="button" onClick={() => setTab("checks")}><ListChecks size={17} /> 理解检查</button></div>
        {!lesson ? <EmptyState title="C 讲义尚未发布" body="D 不会生成占位知识。请等待主 Agent返回 learning_resources.concept_lesson。" /> : tab === "lesson" ? <LessonContent lesson={lesson} onActive={setActiveSection} /> : tab === "lab" ? <LabContent lab={lab} code={code} setCode={setCode} /> : <ChecksContent lesson={lesson} />}
      </section>
      <aside className="lesson-side"><div className="side-tabs"><button className={sideTab === "hint" ? "is-active" : ""} onClick={() => setSideTab("hint")} type="button">学习提示</button><button className={sideTab === "evidence" ? "is-active" : ""} onClick={() => setSideTab("evidence")} type="button">知识来源</button><button className={sideTab === "agents" ? "is-active" : ""} onClick={() => setSideTab("agents")} type="button">Agent过程</button></div>{sideTab === "hint" ? <HintPanel lesson={lesson} /> : sideTab === "evidence" ? <EvidencePanel lesson={lesson} /> : <AgentPanel />}</aside>
    </div>
  </div>
}

function LessonContent({ lesson, onActive }: { lesson: LessonPayload; onActive: (id: string) => void }) {
  return <div className="lesson-document">
    <LessonSection id="prerequisite" title="连接已有知识" tone="warm" icon={<Layers3 />} onActive={onActive}>{lesson.prerequisite_bridge.length ? lesson.prerequisite_bridge.map((block) => <RenderLessonBlock block={block} key={block.block_id} />) : <MissingContent text="C 未公开 prerequisite_bridge" />}</LessonSection>
    <LessonSection id="concept" title="核心概念" tone="plain" icon={<Lightbulb />} onActive={onActive}>{lesson.explanation_blocks.map((block) => <RenderLessonBlock block={block} key={block.block_id} />)}</LessonSection>
    <LessonSection id="examples" title="分步示例" tone="blue" icon={<Braces />} onActive={onActive}>{lesson.worked_examples.length ? lesson.worked_examples.map((block) => <RenderLessonBlock block={block} key={block.block_id} />) : <MissingContent text="C 未公开 worked_examples" />}</LessonSection>
    <LessonSection id="misconceptions" title="常见误区" tone="amber" icon={<MessageCircleQuestion />} onActive={onActive}>{lesson.misconceptions.length ? <div className="misconception-grid">{lesson.misconceptions.map((item) => <article key={item.misconception_tag}><b>{item.objective_id}</b><p>{item.explanation}</p><small>{formatCitations(item.citations)}</small></article>)}</div> : <MissingContent text="C 未公开 misconceptions" />}</LessonSection>
    <LessonSection id="summary" title="本节小结" tone="mint" icon={<CheckCircle2 />} onActive={onActive}>{lesson.summary.length ? lesson.summary.map((block) => <RenderLessonBlock block={block} key={block.block_id} />) : <MissingContent text="C 未公开 summary" />}</LessonSection>
  </div>
}

function LessonSection({ id, title, tone, icon, children, onActive }: { id: string; title: string; tone: string; icon: React.ReactNode; children: React.ReactNode; onActive: (id: string) => void }) {
  return <section id={`section-${id}`} className={`lesson-section tone-${tone}`} onMouseEnter={() => onActive(id)}><header><span>{icon}</span><h2>{title}</h2></header>{children}</section>
}

function RenderLessonBlock({ block }: { block: LessonPayload["explanation_blocks"][number] }) {
  if (block.block_type === "heading") return <h3 className="block-heading">{block.text}</h3>
  if (block.block_type === "paragraph") return <article className="prose-block"><p>{block.text}</p><CitationChips citations={block.claims.flatMap((claim) => claim.citations)} /></article>
  if (block.block_type === "code") return <article className="code-example"><div className="code-head"><span>{block.caption ?? "Python 示例"}</span><small>{block.language}</small></div><CodeViewer code={block.code} /><CitationChips citations={block.claims.flatMap((claim) => claim.citations)} /></article>
  if (block.block_type === "callout") return <article className={`callout callout-${block.tone}`}><b>{block.title}</b><p>{block.text}</p><CitationChips citations={block.claims.flatMap((claim) => claim.citations)} /></article>
  if (block.block_type === "comparison") return <article className="comparison-block"><h3>{block.title}</h3><div>{block.columns.map((column) => <section key={column.heading}><b>{column.heading}</b><p>{column.content}</p></section>)}</div><CitationChips citations={block.claims.flatMap((claim) => claim.citations)} /></article>
  return null
}

function CodeViewer({ code }: { code: string }) {
  const [step, setStep] = useState(0)
  const [playing, setPlaying] = useState(false)
  const lines = code.split("\n")
  useEffect(() => {
    if (!playing || lines.length < 2) return
    const timer = window.setInterval(() => setStep((value) => {
      if (value >= lines.length - 1) {
        setPlaying(false)
        return value
      }
      return value + 1
    }), 720)
    return () => window.clearInterval(timer)
  }, [playing, lines.length])
  const effectiveStep = Math.min(step, Math.max(0, lines.length - 1))
  return <div className="code-viewer"><div className="code-lines">{lines.map((line, index) => <div className={index === effectiveStep ? "is-current" : index < effectiveStep ? "is-past" : ""} key={`${index}-${line}`}><span>{index + 1}</span><code>{line || " "}</code></div>)}</div><div className="code-controls"><button type="button" onClick={() => setStep((value) => Math.max(0, value - 1))}><ChevronLeft size={15} /> 上一步</button><button type="button" onClick={() => { setPlaying((value) => !value); if (!playing && effectiveStep >= lines.length - 1) setStep(0) }}>{playing ? <Pause size={15} /> : <Play size={15} />} {playing ? "暂停播放" : "自动演示"}</button><button type="button" onClick={() => setStep((value) => Math.min(lines.length - 1, value + 1))}>下一步 <ChevronRight size={15} /></button></div></div>
}

function LabContent({ lab, code, setCode }: { lab?: CodeLabPayload; code: string; setCode: (code: string) => void }) {
  if (!lab) return <EmptyState title="代码实验尚未发布" body="D 不会自造 starter code 或测试。请等待主 Agent返回 learning_resources.code_lab。" />
  return <div className="lab-workspace"><section className="lab-instructions"><span className="eyebrow"><FlaskConical size={15} /> {lab.lab_id}</span><h2>{lab.title}</h2>{lab.instructions.map((block) => <RenderLessonBlock block={block} key={block.block_id} />)}<div className="public-tests"><h3>公开测试</h3>{lab.public_tests.map((test) => <article key={test.test_id}><CheckCircle2 size={16} /><div><b>{test.description}</b><p>{test.expected_behavior}</p></div></article>)}</div></section><section className="editor-panel"><header><div><Braces size={17} /><b>Python 编辑器</b></div><small>{lab.execution_contract.execution_mode} · {lab.execution_contract.resource_limits.timeout_ms}ms</small></header><textarea spellCheck={false} value={code} onChange={(event) => setCode(event.target.value)} /><footer><button type="button" onClick={() => setCode(lab.starter_code)}><RotateCcw size={15} /> 重置</button></footer><div className="run-result is-visible"><b>当前主 Agent合同未提供代码运行命令</b><p>D 仅展示 C 发布的 starter code 与公开测试，不在浏览器伪造运行输出或通过状态。</p></div></section></div>
}

function ChecksContent({ lesson }: { lesson: LessonPayload }) {
  const [open, setOpen] = useState<string | null>(null)
  const [answers, setAnswers] = useState<Record<string, string>>({})
  return <div className="checks-workspace"><header><span className="eyebrow"><ListChecks size={15} /> 课件内理解检查</span><h2>边学边检查，不计入正式 mastery</h2><p>所有题目均来自 C 的 micro_checks；如果 C 没有给选项，D 只提供文本作答，不补造答案。</p></header>{lesson.micro_checks.length ? lesson.micro_checks.map((check, index) => <article className="micro-check" key={check.item_id}><div className="micro-number">{String(index + 1).padStart(2, "0")}</div><div><h3>{check.prompt}</h3>{check.options?.length ? <div className="check-options">{check.options.map((option) => <button className={answers[check.item_id] === option.option_id ? "is-selected" : ""} onClick={() => setAnswers((current) => ({ ...current, [check.item_id]: option.option_id }))} type="button" key={option.option_id}>{option.label}. {option.text}</button>)}</div> : <textarea value={answers[check.item_id] ?? ""} onChange={(event) => setAnswers((current) => ({ ...current, [check.item_id]: event.target.value }))} placeholder="写下你的理解；不会在前端自动判分" />}<button className="source-toggle" type="button" onClick={() => setOpen(open === check.item_id ? null : check.item_id)}>{open === check.item_id ? "收起来源" : "查看来源"} <ChevronDown size={15} /></button>{open === check.item_id && <p className="source-line">{formatCitations(check.citations)}</p>}</div></article>) : <MissingContent text="C 未公开 micro_checks，D 不补造理解题。" />}</div>
}

function HintPanel({ lesson }: { lesson?: LessonPayload }) {
  const [level, setLevel] = useState(1)
  const ladder = lesson?.hint_ladders?.[0]
  const hint = ladder?.hints.find((item) => item.hint_level === level)
  return <div className="side-panel-content"><span className="side-kicker"><Lightbulb size={15} /> 分层提示</span><h3>{ladder ? `${ladder.objective_id} 的提示阶梯` : "当前没有公开提示"}</h3>{hint ? <><p className="hint-copy">{hint.text}</p><CitationChips citations={hint.citations} /><div className="hint-levels">{[1, 2, 3].map((value) => <button className={level === value ? "is-active" : ""} type="button" onClick={() => setLevel(value)} key={value}>提示 {value}</button>)}</div></> : <p className="muted-copy">D 不会临时生成提示。接入后仅展示 C 公开的 hint_ladders。</p>}</div>
}

function EvidencePanel({ lesson }: { lesson?: LessonPayload }) {
  const evidence = uniqueCitations([...(lesson?.used_evidence ?? []), ...(lesson ? lesson.prerequisite_bridge.flatMap(blockCitations) : [])])
  return <div className="side-panel-content"><span className="side-kicker"><ShieldCheck size={15} /> 可追溯证据</span><h3>{evidence.length} 条公开引用</h3><p className="muted-copy">只展示 source_id / fact_id；缺失证据会如实显示，不生成虚构来源。</p><div className="evidence-list">{evidence.map((citation) => <article key={`${citation.source_id}-${citation.fact_id}`}><FileText size={16} /><div><b>{citation.source_id}</b><span>{citation.fact_id}</span></div><ExternalLink size={14} /></article>)}</div></div>
}

function AgentPanel() {
  const activeSession = useRequiredSession()
  const workers = activeSession.worker_ledger
  return <div className="side-panel-content"><span className="side-kicker"><Bot size={15} /> 主 Agent协同</span><h3>{workers.length} 个固定 Worker</h3><p className="muted-copy">状态来自持久化 worker_ledger。这里不播放与真实事件无关的“AI思考”动画。</p><div className="agent-list">{workers.map((worker) => <article key={worker.worker}><span className={`agent-status status-${worker.status}`} /> <div><b>{workerLabel(worker.worker)}</b><small>{worker.status}</small></div></article>)}</div></div>
}

function AssessmentPage({ onFeedback: _onFeedback }: { onFeedback: () => void }) {
  const { isLive, assessmentAnswers: answers, setAssessmentAnswer, submitAssessment, busy } = useLive()
  const activeSession = useRequiredSession()
  const assessment = activeSession.assessment?.payload
  const [index, setIndex] = useState(0)
  if (!assessment?.items?.length) return <div className="page"><EmptyState title="正式测评尚未公开" body="D 不会自行生成正式题目。接入后等待主 Agent返回 assessment。" /></div>
  const item = assessment.items[index]
  const complete = Object.values(answers).filter(Boolean).length
  return <div className="page assessment-page"><PageHeading kicker={`正式测评 · ${assessment.title}`} title="提交后进入 Role C 正式评分" description="正确答案、评分规范与隐藏测试始终保留在服务端。当前作答会通过主 Agent命令提交，不在 D 中评分。" />
    <section className="assessment-shell"><aside><b>测评进度</b>{assessment.items.map((candidate, itemIndex) => <button className={itemIndex === index ? "is-active" : answers[candidate.item_id] ? "is-complete" : ""} type="button" onClick={() => setIndex(itemIndex)} key={candidate.item_id}><span>{itemIndex + 1}</span><small>{modalityLabel(candidate.modality)}</small></button>)}<p>{complete} / {assessment.items.length} 已作答</p></aside><article className="formal-question"><div className="question-meta"><span>第 {index + 1} 题</span><span>Tier {item.tier}</span><span>{item.max_score} 分</span></div><h2>{item.prompt}</h2>{item.options?.length ? <div className="formal-options">{item.options.map((option) => <button className={answers[item.item_id] === option.option_id ? "is-selected" : ""} type="button" onClick={() => setAssessmentAnswer(item.item_id, option.option_id)} key={option.option_id}><span>{option.label}</span><b>{option.text}</b></button>)}</div> : <textarea rows={item.modality === "code" ? 14 : 6} value={answers[item.item_id] ?? item.starter_code ?? ""} onChange={(event) => setAssessmentAnswer(item.item_id, event.target.value)} /> }<div className="formal-actions"><button className="secondary-action" disabled={index === 0} type="button" onClick={() => setIndex((value) => value - 1)}>上一题</button>{index < assessment.items.length - 1 ? <button className="primary-action" disabled={!answers[item.item_id]} type="button" onClick={() => setIndex((value) => value + 1)}>保存并下一题</button> : <button className="primary-action" disabled={Boolean(busy) || !assessmentComplete(activeSession, answers) || !isLive} type="button" onClick={() => void submitAssessment()}>{busy ? "正在正式评分…" : "提交正式测评"} <ArrowRight /></button>}</div></article></section>
  </div>
}

function FeedbackPage({ onContinue }: { onContinue: () => void }) {
  const { retry, busy } = useLive()
  const activeSession = useRequiredSession()
  const feedback: any = activeSession.feedback
  const decision = feedback?.final_decision
  if (!feedback && activeSession.status !== "blocked" && activeSession.status !== "failed") return <div className="page feedback-page"><PageHeading kicker="正式反馈" title="等待 Role C 正式评分结果" description="D 不会根据作答或题目难度在浏览器里估算结果。" /><section className="feedback-empty"><div className="feedback-icon"><Sparkles /></div><h2>评分结果尚未返回</h2><p>完成正式测评后，主 Agent会持久化公开反馈与下一步决策。</p><button className="primary-action" type="button" onClick={onContinue}>返回互动学习</button></section></div>
  return <div className="page feedback-page"><PageHeading kicker={`正式反馈 · 第 ${activeSession.round_no > 1 ? activeSession.round_no - 1 : activeSession.round_no} 轮`} title={activeSession.status === "blocked" ? "下一步暂时受阻" : decisionTitle(decision?.action)} description={feedback?.feedback_summary || activeSession.blocked_reason || "主 Agent已返回本轮正式决策。"} /><section className="feedback-result-grid"><article className="score-card"><span>本轮正式得分</span><strong>{feedback?.round_score ? `${feedback.round_score.raw_score} / ${feedback.round_score.max_score}` : "--"}</strong><p>{feedback?.round_score ? `正确率 ${Math.round(feedback.round_score.accuracy * 100)}% · 证据分 ${Math.round(feedback.round_score.evidence_score * 100)}%` : "已保留此前评分，等待下一轮恢复。"}</p></article><article className="decision-card"><span>主 Agent下一步</span><h2>{decision?.action ? decisionLabel(decision.action) : "等待恢复"}</h2><p>{decision?.reason_codes?.join("、") || activeSession.blocked_reason || "暂无公开原因码"}</p></article></section>{feedback?.objective_results?.length ? <section className="objective-feedback"><h2>学习目标反馈</h2>{feedback.objective_results.map((item: any) => <article key={item.objective_id}><div><b>{item.objective_id}</b><span>{Math.round(item.accuracy * 100)}%</span></div><div className="objective-meter"><i style={{ width: `${Math.round(item.accuracy * 100)}%` }} /></div><p>{item.misconception_tags?.length ? `需要关注：${item.misconception_tags.join("、")}` : "本轮未返回误区标签"}</p></article>)}</section> : null}<div className="page-actions">{activeSession.status === "blocked" || activeSession.status === "failed" ? <button className="primary-action" disabled={Boolean(busy)} type="button" onClick={() => void retry()}>{busy ? "正在恢复…" : "从持久化检查点重试"}</button> : <button className="primary-action" type="button" onClick={onContinue}>{activeSession.status === "completed" ? "查看学习记录" : "进入下一轮学习"}</button>}</div></div>
}

function HistoryPage() {
  const { refreshEvents } = useLive()
  const activeSession = useRequiredSession()
  const events = activeSession.events.slice(-10).reverse()
  return <div className="page history-page"><PageHeading kicker="学习记录" title="主 Agent持久化的真实过程" description="页面读取 events 与 worker_ledger，不由 D 拼接虚假的执行链。" /><div className="history-refresh"><button className="secondary-action" type="button" onClick={() => void refreshEvents()}>刷新真实事件</button></div><section className="history-layout"><article className="session-summary"><span>当前实时会话</span><h2>{activeSession.session_id}</h2><p>此处仅展示主 Agent公开会话状态和事件。</p><dl><div><dt>状态</dt><dd>{activeSession.status}</dd></div><div><dt>阶段</dt><dd>{activeSession.current_stage}</dd></div><div><dt>轮次</dt><dd>{activeSession.round_no}</dd></div><div><dt>更新时间</dt><dd>{formatTime(activeSession.updated_at)}</dd></div></dl></article><div className="event-timeline">{events.map((event, index) => <article key={`${event.seq ?? index}-${event.event_type}`}><span className={`event-dot status-${event.status ?? "pending"}`} /><div><div><b>{eventStage(event)}</b><time>{formatTime(event.occurred_at)}</time></div><p>{event.summary || event.event_type}</p><small>{event.agent || event.worker || "learning-orchestrator"}</small></div></article>)}</div></section></div>
}

function NoSessionState({ onStart }: { onStart: () => void }) {
  return <div className="page"><section className="empty-state"><ShieldCheck size={29} /><h2>需要先创建主 Agent会话</h2><p>为避免伪造，D 不会在没有服务端会话时展示画像、学习方案、C 讲义、正式测评、评分或 Worker状态。</p><button className="primary-action" type="button" onClick={onStart}>新建真实学习会话</button></section></div>
}

function PageHeading({ kicker, title, description }: { kicker: string; title: string; description: string }) {
  return <header className="page-heading"><span>{kicker}</span><h1>{title}</h1><p>{description}</p></header>
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return <section className="empty-state"><FileText size={29} /><h2>{title}</h2><p>{body}</p></section>
}

function MissingContent({ text }: { text: string }) {
  return <div className="missing-content"><FileText size={17} /><span>{text}</span></div>
}

function CitationChips({ citations }: { citations: Citation[] }) {
  const unique = uniqueCitations(citations)
  if (!unique.length) return null
  return <div className="citation-chips">{unique.map((citation) => <span key={`${citation.source_id}-${citation.fact_id}`}>{citation.source_id} · {citation.fact_id}</span>)}</div>
}

function blockCitations(block: LessonPayload["explanation_blocks"][number]): Citation[] {
  if (block.block_type === "paragraph" || block.block_type === "code" || block.block_type === "callout" || block.block_type === "comparison") return block.claims.flatMap((claim) => claim.citations)
  if (block.block_type === "quiz" || block.block_type === "hint" || block.block_type === "citation") return block.citations
  return []
}

function uniqueCitations(citations: Citation[]): Citation[] {
  return [...new Map(citations.map((citation) => [`${citation.source_id}:${citation.fact_id}`, citation])).values()]
}

function lessonOutline(lesson: LessonPayload) {
  return [
    { id: "prerequisite", title: "连接已有知识", visible: lesson.prerequisite_bridge.length > 0 },
    { id: "concept", title: "核心概念", visible: lesson.explanation_blocks.length > 0 },
    { id: "examples", title: "分步示例", visible: lesson.worked_examples.length > 0 },
    { id: "misconceptions", title: "常见误区", visible: lesson.misconceptions.length > 0 },
    { id: "summary", title: "本节小结", visible: lesson.summary.length > 0 },
  ].filter((item) => item.visible)
}

function formatCitations(citations: Citation[]) {
  return uniqueCitations(citations).map((citation) => `${citation.source_id}/${citation.fact_id}`).join("、") || "未公开引用"
}

function diagnosisGateLabel(session: PublicSessionFixture) {
  const count = session.waiting_for?.type === "diagnosis_answers" ? session.waiting_for.items.length : 0
  return count > 0 ? `等待完成 ${count} 道主 Agent诊断题` : "等待主 Agent继续"
}

function waitingLabel(type?: string) {
  return ({ diagnosis_answers: "等待诊断作答", assessment_answers: "等待正式测评", clarification_answer: "等待补充回答" } as Record<string, string>)[type ?? ""] ?? "等待你继续"
}

function stageLabel(session: PublicSessionFixture) {
  if (session.waiting_for?.type === "diagnosis_answers") return `客观诊断 · ${session.waiting_for.items.length} 题`
  if (session.waiting_for?.type === "assessment_answers") return "互动学习与正式测评"
  return ({ objective_diagnosis: "客观诊断", assessment: "互动学习与正式测评", completed: "学习完成", blocked: "流程受阻", failed: "流程失败" } as Record<string, string>)[session.current_stage] ?? session.current_stage
}

function decisionLabel(action?: string) {
  return ({ remediate: "开始针对性补救", reinforce: "进入巩固学习", advance: "进入下一知识节点", reprofile: "重新确认学习画像", complete: "完成本次学习" } as Record<string, string>)[action ?? ""] ?? "等待主 Agent决定"
}

function decisionTitle(action?: string) {
  return ({ remediate: "本轮需要针对性补救", reinforce: "本轮进入巩固学习", advance: "可以进入下一知识节点", reprofile: "需要重新确认学习情况", complete: "本次学习已完成" } as Record<string, string>)[action ?? ""] ?? "主 Agent已完成本轮决策"
}

function modalityLabel(modality: AssessmentPayload["items"][number]["modality"]) {
  return ({ mcq: "选择题", true_false: "判断题", trace: "代码追踪", short_answer: "简答题", code: "代码题" })[modality]
}

function behaviorLabel(value: string) {
  return ({ trace: "追踪执行过程", apply: "应用知识", create: "完成作品" } as Record<string, string>)[value] ?? value
}

function workerLabel(worker: string) {
  return ({
    "background-collector": "历史与背景",
    "self-assessor": "学习者自评",
    "objective-diagnostician": "客观诊断",
    "profile-builder": "画像构建",
    "path-planner": "路径规划",
    "concept-tutor": "定制讲义",
    "code-lab": "代码实验",
    "tiered-evaluator": "分阶测评",
  } as Record<string, string>)[worker] ?? worker
}

function eventStage(event: PublicSessionFixture["events"][number]) {
  if (event.agent) return workerLabel(event.agent)
  if (event.worker) return workerLabel(event.worker)
  return event.event_type ?? "主 Agent事件"
}

function formatTime(value?: string) {
  if (!value) return "--"
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
}

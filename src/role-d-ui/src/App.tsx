import { useEffect, useMemo, useState } from "react"
import { CheckCircle2, Database, Network, Plus, RotateCcw } from "lucide-react"
import { AppSidebar } from "./components/AppSidebar"
import { ConfirmDialog } from "./components/ConfirmDialog"
import { DetailDrawer } from "./components/DetailDrawer"
import { EvidenceInspector } from "./components/EvidenceInspector"
import { NewPlanDialog } from "./components/NewPlanDialog"
import { ProgressFileControls } from "./components/ProgressFileControls"
import { WorkflowTimeline } from "./components/WorkflowTimeline"
import { demoHandoff } from "./data/demo-handoff"
import { adaptHandoff } from "./domain/adapt-handoff"
import { createLearningPlan, evaluatePlanDiagnosis, type CreatedLearningPlan, type NewLearningPlanInput } from "./domain/create-learning-plan"
import { furthestStage, stageIndex } from "./domain/guided-flow"
import { clearSession, loadSession, saveSession } from "./domain/session-store"
import type { GuidedStage, RoleDSession, WorkflowEventView } from "./domain/types"
import { applyWorkflowEvent } from "./domain/workflow-events"
import { DiagnosisScreen } from "./screens/DiagnosisScreen"
import { FeedbackScreen } from "./screens/FeedbackScreen"
import { LearningScreen } from "./screens/LearningScreen"
import { OnboardingScreen } from "./screens/OnboardingScreen"
import { PlanScreen } from "./screens/PlanScreen"
import { ProfileScreen } from "./screens/ProfileScreen"

declare global {
  interface WindowEventMap {
    "knowbalance:workflow-event": CustomEvent<WorkflowEventView>
  }
}

export function App() {
  const demoSession = useMemo(() => adaptHandoff(demoHandoff), [])
  const [session, setSession] = useState<RoleDSession>(() => loadSession() ?? demoSession)
  const [restartOpen, setRestartOpen] = useState(false)
  const [newPlanOpen, setNewPlanOpen] = useState(false)
  const [saved, setSaved] = useState(true)
  const [onboardingSubmitting, setOnboardingSubmitting] = useState(false)
  const [onboardingError, setOnboardingError] = useState("")

  useEffect(() => setSaved(saveSession(session)), [session])
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" })
  }, [session.view.currentStage])
  useEffect(() => {
    const onWorkflowEvent = (event: CustomEvent<WorkflowEventView>) => setSession((current) => applyWorkflowEvent(current, event.detail))
    window.addEventListener("knowbalance:workflow-event", onWorkflowEvent)
    return () => window.removeEventListener("knowbalance:workflow-event", onWorkflowEvent)
  }, [])

  const updateView = (patch: Partial<RoleDSession["view"]>) => setSession((current) => ({
    ...current,
    view: { ...current.view, ...patch },
  }))

  const selectStage = (currentStage: GuidedStage) => {
    if (stageIndex(currentStage) <= stageIndex(session.view.maxUnlockedStage)) updateView({ currentStage })
  }

  const unlockStage = (currentStage: GuidedStage) => updateView({
    currentStage,
    maxUnlockedStage: furthestStage(session.view.maxUnlockedStage, currentStage),
  })

  const renderStage = () => {
    switch (session.view.currentStage) {
      case "onboarding":
        return <OnboardingScreen isDemo={session.planSource === "demo"} goal={session.view.goalDraft} selfRating={session.view.selfRatingDraft} onGoalChange={(goalDraft) => updateView({ goalDraft })} onRatingChange={(selfRatingDraft) => updateView({ selfRatingDraft })} onContinue={continueOnboarding} submitting={onboardingSubmitting} error={onboardingError} />
      case "diagnosis":
        return <DiagnosisScreen diagnosis={session.diagnosis} answer={session.view.diagnosisAnswer} submitted={session.view.diagnosisSubmitted} onAnswer={(diagnosisAnswer) => updateView({ diagnosisAnswer, diagnosisSubmitted: false })} onSubmit={submitDiagnosis} onContinue={() => unlockStage("profile")} onBack={() => selectStage("onboarding")} />
      case "profile":
        return <ProfileScreen session={session} onContinue={() => unlockStage("plan")} onBack={() => selectStage("diagnosis")} />
      case "plan":
        return <PlanScreen session={session} onContinue={() => unlockStage("learning")} onBack={() => selectStage("profile")} />
      case "learning":
        return <LearningScreen session={session} onTab={(activeArtifactKind) => updateView({ activeArtifactKind })} onCitation={(selectedSourceId) => updateView({ selectedSourceId, detailDrawer: "evidence" })} onAssessmentAnswer={(itemId, answer) => updateView({ assessmentAnswers: { ...(session.view.assessmentAnswers ?? {}), [itemId]: answer }, assessmentSubmitted: false })} onAssessmentSubmit={() => updateView({ assessmentSubmitted: true })} onContinue={() => unlockStage("feedback")} onBack={() => selectStage("plan")} />
      case "feedback":
        return <FeedbackScreen session={session} onRestart={() => updateView({ currentStage: "learning", activeArtifactKind: "lesson", remediationStarted: true })} onBack={() => selectStage("learning")} />
    }
  }

  const drawer = session.view.detailDrawer
  const isWorkflowLive = session.eventMode === "live"
  const workflowLabel = session.planSource === "real-ab" ? "查看 A/B/C 执行链" : "查看 Agent 协同"
  const restartPlan = () => {
    clearSession()
    setSession((current) => current.planSource === "real-ab"
      ? {
          ...current,
          updatedAt: new Date().toISOString(),
          view: {
            ...current.view,
            currentStage: "onboarding",
            maxUnlockedStage: "onboarding",
            activeArtifactKind: "lesson",
            selectedSourceId: current.retrieval.items[0]?.sourceId ?? "",
            remediationStarted: false,
            goalDraft: current.profile.goal,
            selfRatingDraft: current.profile.level,
            diagnosisAnswer: "",
            diagnosisSubmitted: false,
            assessmentAnswers: {},
            assessmentSubmitted: false,
            detailDrawer: "none",
          },
        }
      : adaptHandoff(demoHandoff))
    setRestartOpen(false)
  }
  const createPlan = async (input: NewLearningPlanInput) => {
    const plan = await createLearningPlan(input)
    setSession(plan.session)
    setNewPlanOpen(false)
  }
  const continueOnboarding = async () => {
    setOnboardingSubmitting(true)
    setOnboardingError("")
    try {
      const plan = await createLearningPlan({
        ...session.planInput,
        selfRating: session.view.selfRatingDraft,
        goal: session.view.goalDraft,
      })
      setSession(plan.session)
    } catch (error) {
      setOnboardingError(error instanceof Error ? error.message : "无法创建学习计划，请检查目标后重试。")
    } finally {
      setOnboardingSubmitting(false)
    }
  }
  const submitDiagnosis = async () => {
    if (session.planSource !== "real-ab") {
      updateView({ diagnosisSubmitted: true })
      return
    }
    const plan: CreatedLearningPlan = {
      source: "real-ab",
      input: {
        ...session.planInput,
        selfRating: session.view.selfRatingDraft,
        goal: session.profile.goal,
      },
      diagnosis: session.diagnosis,
      session,
    }
    const updated = await evaluatePlanDiagnosis(plan, session.view.diagnosisAnswer)
    setSession(updated.session)
  }

  return (
    <div className="app-frame">
      <AppSidebar profile={session.profile} currentStage={session.view.currentStage} maxUnlockedStage={session.view.maxUnlockedStage} onStageSelect={selectStage} />
      <main className="main-content">
        <header className="topbar">
          <div className="course-identity"><strong><span>Python</span><small>基础训练</small></strong><span className={`live-indicator${isWorkflowLive ? "" : " is-paused"}`}><i /> {isWorkflowLive ? "实时事件" : session.planSource === "real-ab" ? "A/B 本地实跑" : "案例预览"}</span></div>
          <div className="top-actions">
            <button className="detail-button" type="button" aria-label={workflowLabel} onClick={() => updateView({ detailDrawer: "agents" })}><Network size={17} /><span className="desktop-label">{workflowLabel}</span></button>
            <button className="detail-button" type="button" aria-label="查看知识证据" onClick={() => updateView({ detailDrawer: "evidence" })}><Database size={17} /><span className="desktop-label">查看知识证据</span></button>
            <button className="new-plan-button" type="button" aria-label="新建学习计划" onClick={() => setNewPlanOpen(true)}><Plus size={17} /><span className="desktop-label">新建计划</span></button>
            <button className="restart-button" type="button" aria-label="重新开始当前计划" onClick={() => setRestartOpen(true)}><RotateCcw size={16} /><span className="desktop-label">重新开始</span></button>
            <ProgressFileControls session={session} onImport={setSession} />
            <span className={`save-status${saved ? "" : " is-error"}`}><CheckCircle2 size={16} />{saved ? "已自动保存" : "保存失败"}</span>
          </div>
        </header>
        <div className="guided-layout">
          <div className="guided-canvas">{renderStage()}</div>
          <footer className="app-footer"><span>会话 {session.sessionId}</span><span>进度已自动保存在本机</span></footer>
        </div>
      </main>

      {drawer === "agents" && <DetailDrawer title={session.planSource === "real-ab" ? "A/B/C 执行详情" : "Agent 协同过程"} onClose={() => updateView({ detailDrawer: "none" })}><WorkflowTimeline events={session.workflow} localExecution={session.planSource === "real-ab"} includesRoleC={session.planSource === "real-ab"} /></DetailDrawer>}
      {drawer === "evidence" && <DetailDrawer title="知识证据与引用" onClose={() => updateView({ detailDrawer: "none" })}><EvidenceInspector items={session.retrieval.items} artifacts={session.artifacts} selectedSourceId={session.view.selectedSourceId} onSelect={(selectedSourceId) => updateView({ selectedSourceId })} /></DetailDrawer>}
      {restartOpen && <ConfirmDialog title="重新开始当前计划？" description="这会清除当前阶段、诊断答案和资源选择，并回到学习建档。项目文件和知识库不会被删除。" confirmLabel="清空并重新开始" onCancel={() => setRestartOpen(false)} onConfirm={restartPlan} />}
      {newPlanOpen && <NewPlanDialog onCancel={() => setNewPlanOpen(false)} onCreate={createPlan} />}
    </div>
  )
}

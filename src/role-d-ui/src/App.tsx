import { useEffect, useState } from "react"
import { CheckCircle2, Database, List, Network, Plus, Trash2 } from "lucide-react"
import { AppSidebar } from "./components/AppSidebar"
import { ConfirmDialog } from "./components/ConfirmDialog"
import { DetailDrawer } from "./components/DetailDrawer"
import { EvidenceInspector } from "./components/EvidenceInspector"
import { NewPlanDialog } from "./components/NewPlanDialog"
import { PlanListScreen } from "./components/PlanListScreen"
import { ProgressFileControls } from "./components/ProgressFileControls"
import { UserSetupScreen } from "./components/UserSetupScreen"
import { UserSwitcher } from "./components/UserSwitcher"
import { WorkflowTimeline } from "./components/WorkflowTimeline"
import { createLearningPlan, evaluatePlanDiagnosis, type CreatedLearningPlan, type NewLearningPlanInput } from "./domain/create-learning-plan"
import { furthestStage, stageIndex } from "./domain/guided-flow"
import { diagnosisItems } from "./domain/diagnosis"
import type { GuidedStage, RoleDSession } from "./domain/types"
import { addPlan, createLocalLearner, deletePlan, loadWorkspace, saveWorkspace, selectPlan, switchUser, updateActivePlanSession } from "./domain/workspace-store"

import { DiagnosisScreen } from "./screens/DiagnosisScreen"
import { FeedbackScreen } from "./screens/FeedbackScreen"
import { LearningScreen } from "./screens/LearningScreen"
import { OnboardingScreen } from "./screens/OnboardingScreen"
import { PlanScreen } from "./screens/PlanScreen"
import { ProfileScreen } from "./screens/ProfileScreen"

export function App() {
  const [workspace, setWorkspace] = useState(loadWorkspace)
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [newPlanOpen, setNewPlanOpen] = useState(false)
  const [userSetupOpen, setUserSetupOpen] = useState(false)
  const [userSwitcherOpen, setUserSwitcherOpen] = useState(false)
  const [showPlanList, setShowPlanList] = useState(workspace.activePlanId !== null)
  const [saved, setSaved] = useState(true)
  const [onboardingSubmittingPlanId, setOnboardingSubmittingPlanId] = useState<string | null>(null)
  const [diagnosisSubmittingPlanId, setDiagnosisSubmittingPlanId] = useState<string | null>(null)
  const [onboardingErrors, setOnboardingErrors] = useState<Record<string, string>>({})

  const activeUser = workspace.users.find((user) => user.id === workspace.activeUserId)
  const activePlan = workspace.plans.find((plan) => plan.id === workspace.activePlanId && plan.userId === workspace.activeUserId)
  const session = activePlan?.session

  useEffect(() => setSaved(saveWorkspace(workspace)), [workspace])
  useEffect(() => {
    window.scrollTo({ top: 0, behavior: "auto" })
  }, [session?.view.currentStage, showPlanList])

  const setSession = (next: RoleDSession | ((current: RoleDSession) => RoleDSession)) => setWorkspace((current) => {
    const plan = current.plans.find((candidate) => candidate.id === current.activePlanId)
    if (!plan) return current
    const sessionValue = typeof next === "function" ? next(plan.session) : next
    return updateActivePlanSession(current, sessionValue)
  })
  const updateView = (patch: Partial<RoleDSession["view"]>) => setSession((current) => ({ ...current, view: { ...current.view, ...patch } }))

  const selectStage = (currentStage: GuidedStage) => {
    if (!session) return
    if (stageIndex(currentStage) <= stageIndex(session.view.maxUnlockedStage)) updateView({ currentStage })
  }

  const unlockStage = (currentStage: GuidedStage) => {
    if (!session) return
    updateView({ currentStage, maxUnlockedStage: furthestStage(session.view.maxUnlockedStage, currentStage) })
  }

  const renderStage = () => {
    if (!session) return null
    switch (session.view.currentStage) {
      case "onboarding":
        return <OnboardingScreen isDemo={session.planSource === "demo"} goal={session.view.goalDraft} selfRating={session.view.selfRatingDraft} onGoalChange={(goalDraft) => updateView({ goalDraft })} onRatingChange={(selfRatingDraft) => updateView({ selfRatingDraft })} onContinue={continueOnboarding} submitting={onboardingSubmittingPlanId === activePlan?.id} error={activePlan ? onboardingErrors[activePlan.id] ?? "" : ""} />
      case "diagnosis":
        return <DiagnosisScreen diagnosis={session.diagnosis} answers={session.view.diagnosisAnswers ?? {}} submitted={session.view.diagnosisSubmitted} submitting={diagnosisSubmittingPlanId === activePlan?.id} onAnswer={(itemId, answer) => updateView({ diagnosisAnswers: { ...(session.view.diagnosisAnswers ?? {}), [itemId]: answer }, diagnosisAnswer: answer, diagnosisSubmitted: false })} onSubmit={submitDiagnosis} onContinue={() => unlockStage("profile")} onBack={() => selectStage("onboarding")} />
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

  if (!activeUser) return <UserSetupScreen saved={saved} onCreate={(input) => {
    const user = createLocalLearner(input)
    setWorkspace({ ...workspace, activeUserId: user.id, activePlanId: null, users: [...workspace.users, user] })
  }} />

  if (!session || showPlanList) return <>
    <PlanListScreen user={activeUser} plans={workspace.plans.filter((plan) => plan.userId === activeUser.id)} saved={saved} onCreate={() => setNewPlanOpen(true)} onOpen={(planId) => { setWorkspace((current) => selectPlan(current, planId)); setShowPlanList(false) }} onSwitchUser={() => setUserSwitcherOpen(true)} />
    {newPlanOpen && <NewPlanDialog user={activeUser} onCancel={() => setNewPlanOpen(false)} onCreate={createPlan} />}
    {userSwitcherOpen && <UserSwitcher users={workspace.users} activeUserId={activeUser.id} onClose={() => setUserSwitcherOpen(false)} onSelect={(userId) => { setWorkspace((current) => switchUser(current, userId)); setUserSwitcherOpen(false) }} onAdd={() => { setUserSwitcherOpen(false); setUserSetupOpen(true) }} />}
    {userSetupOpen && <UserSetupScreen saved={saved} canCancel onCancel={() => setUserSetupOpen(false)} onCreate={(input) => { const user = createLocalLearner(input); setWorkspace((current) => ({ ...current, activeUserId: user.id, activePlanId: null, users: [...current.users, user] })); setUserSetupOpen(false) }} />}
  </>

  const drawer = session.view.detailDrawer
  const workflowLabel = session.planSource === "real-ab" ? "查看 A/B/C 执行链" : "查看 Agent 协同"
  async function createPlan(input: NewLearningPlanInput & { title?: string }) {
    const plan = await createLearningPlan(input)
    setWorkspace((current) => addPlan(current, activeUser!.id, { id: crypto.randomUUID(), title: input.title?.trim() || input.goal, session: plan.session }))
    setNewPlanOpen(false)
    setShowPlanList(false)
  }
  const continueOnboarding = async () => {
    const targetPlanId = activePlan!.id
    setOnboardingSubmittingPlanId(targetPlanId)
    setOnboardingErrors((current) => ({ ...current, [targetPlanId]: "" }))
    try {
      const plan = await createLearningPlan({
        ...session.planInput,
        selfRating: session.view.selfRatingDraft,
        goal: session.view.goalDraft,
      })
      setWorkspace((current) => {
        if (!current.plans.some((candidate) => candidate.id === targetPlanId)) return current
        return {
          ...current,
          plans: current.plans.map((candidate) => candidate.id === targetPlanId
            ? { ...candidate, session: plan.session, updatedAt: new Date().toISOString() }
            : candidate),
        }
      })
    } catch (error) {
      setOnboardingErrors((current) => ({ ...current, [targetPlanId]: error instanceof Error ? error.message : "无法创建学习计划，请检查目标后重试。" }))
    } finally {
      setOnboardingSubmittingPlanId((current) => current === targetPlanId ? null : current)
    }
  }
  const submitDiagnosis = async () => {
    if (session.planSource !== "real-ab") {
      updateView({ diagnosisSubmitted: true })
      return
    }
    const targetPlanId = activePlan!.id
    const plan: CreatedLearningPlan = {
      source: "real-ab",
      input: {
        ...session.planInput,
        selfRating: session.view.selfRatingDraft,
        goal: session.profile.goal,
      },
      diagnosis: { ...session.diagnosis, items: diagnosisItems(session.diagnosis) },
      session,
    }
    setDiagnosisSubmittingPlanId(targetPlanId)
    try {
      const updated = await evaluatePlanDiagnosis(plan, session.view.diagnosisAnswers ?? {})
      setWorkspace((current) => {
        if (!current.plans.some((candidate) => candidate.id === targetPlanId)) return current
        return {
          ...current,
          plans: current.plans.map((candidate) => candidate.id === targetPlanId
            ? { ...candidate, session: updated.session, updatedAt: new Date().toISOString() }
            : candidate),
        }
      })
    } finally {
      setDiagnosisSubmittingPlanId((current) => current === targetPlanId ? null : current)
    }
  }

  return (
    <div className="app-frame">
      <AppSidebar profile={session.profile} learnerName={activeUser.displayName} currentStage={session.view.currentStage} maxUnlockedStage={session.view.maxUnlockedStage} onStageSelect={selectStage} />
      <main className="main-content">
        <header className="topbar">
          <div className="course-identity"><strong><span>Python</span><small>基础训练</small></strong></div>
          <div className="top-actions">
            <button className="detail-button" type="button" aria-label={workflowLabel} onClick={() => updateView({ detailDrawer: "agents" })}><Network size={17} /><span className="desktop-label">{workflowLabel}</span></button>
            <button className="detail-button" type="button" aria-label="查看知识证据" onClick={() => updateView({ detailDrawer: "evidence" })}><Database size={17} /><span className="desktop-label">查看知识证据</span></button>
            <button className="detail-button" type="button" aria-label="返回学习计划单" onClick={() => setShowPlanList(true)}><List size={17} /><span className="desktop-label">计划单</span></button>
            <button className="new-plan-button" type="button" aria-label="新建学习计划" onClick={() => setNewPlanOpen(true)}><Plus size={17} /><span className="desktop-label">新建计划</span></button>
            <button className="restart-button" type="button" aria-label="删除当前学习计划" onClick={() => setDeleteOpen(true)}><Trash2 size={16} /><span className="desktop-label">删除计划</span></button>
            <ProgressFileControls session={session} onImport={(imported) => {
              setWorkspace((current) => addPlan(current, activeUser.id, { id: crypto.randomUUID(), title: `导入 · ${imported.profile.goal}`, session: imported }))
              setShowPlanList(true)
            }} />
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
      {deleteOpen && <ConfirmDialog title="删除当前学习计划？" description="这会删除当前计划的画像、资源、答案和学习进度，但不会影响该用户的其他计划。" confirmLabel="删除计划" onCancel={() => setDeleteOpen(false)} onConfirm={() => { setWorkspace((current) => deletePlan(current, activePlan!.id)); setDeleteOpen(false); setShowPlanList(true) }} />}
      {newPlanOpen && <NewPlanDialog user={activeUser} onCancel={() => setNewPlanOpen(false)} onCreate={createPlan} />}
    </div>
  )
}

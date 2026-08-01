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
import { createLearningPlan, createLearningPlanDraft, evaluatePlanDiagnosis, type CreatedLearningPlan, type NewLearningPlanInput } from "./domain/create-learning-plan"
import { applyRoleCSubmissionOutcome, buildRoleCSubmissionAnswers, updatePath } from "./domain/role-c-submission"
import { submitRoleCAssessment } from "./domain/role-c-submission-client"
import { continueRoleCAfterSubmission, continuationToRoleDArtifacts, continuationToRoleDWorkflow, routeRoleCAssessmentAnchors } from "./domain/role-c-continuation"
import { furthestStage, stageIndex } from "./domain/guided-flow"
import { previewLearningArtifacts } from "./domain/preview-mode"
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
  const [continuingPlanId, setContinuingPlanId] = useState<string | null>(null)
  const [routingPlanId, setRoutingPlanId] = useState<string | null>(null)
  const [onboardingErrors, setOnboardingErrors] = useState<Record<string, string>>({})
  const [previewPlanId, setPreviewPlanId] = useState<string | null>(null)
  const activeUser = workspace.users.find((user) => user.id === workspace.activeUserId)
  const activePlan = workspace.plans.find((plan) => plan.id === workspace.activePlanId && plan.userId === workspace.activeUserId)
  const session = activePlan?.session
  const previewMode = Boolean(activePlan && previewPlanId === activePlan.id)
  const hasUnsubmittedAssessmentDraft = Boolean(session?.view.currentStage === "learning" && session.view.assessmentStatus !== "submitting" && !session.view.assessmentSubmitted && Object.values(session.view.assessmentAnswers ?? {}).some((answer) => answer.trim().length > 0))

  useEffect(() => setSaved(saveWorkspace(workspace)), [workspace])
  useEffect(() => {
    if (!hasUnsubmittedAssessmentDraft) return
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = "" }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [hasUnsubmittedAssessmentDraft])
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
        return <OnboardingScreen isDemo={session.planSource === "demo"} isDraft={session.retrieval.items.length === 0 && session.diagnosis.items?.length === 0} goal={session.view.goalDraft} knownConcepts={session.planInput.knownConcepts} weakConcepts={session.planInput.weakConcepts} learnerLevelLabel={learnerLevelLabel(activeUser?.selfRating)} onGoalChange={(goalDraft) => setSession((current) => ({ ...current, planInput: { ...current.planInput, goal: goalDraft }, profile: { ...current.profile, goal: goalDraft }, view: { ...current.view, goalDraft } }))} onKnownConceptsChange={(knownConcepts) => setSession((current) => ({ ...current, planInput: { ...current.planInput, knownConcepts }, profile: { ...current.profile, knownConcepts } }))} onWeakConceptsChange={(weakConcepts) => setSession((current) => ({ ...current, planInput: { ...current.planInput, weakConcepts }, profile: { ...current.profile, weakConcepts } }))} onContinue={continueOnboarding} submitting={onboardingSubmittingPlanId === activePlan?.id} error={activePlan ? onboardingErrors[activePlan.id] ?? "" : ""} />
      case "diagnosis":
        return <DiagnosisScreen diagnosis={session.diagnosis} answers={session.view.diagnosisAnswers ?? {}} submitted={session.view.diagnosisSubmitted} submitting={diagnosisSubmittingPlanId === activePlan?.id} onAnswer={(itemId, answer) => updateView({ diagnosisAnswers: { ...(session.view.diagnosisAnswers ?? {}), [itemId]: answer }, diagnosisAnswer: answer, diagnosisSubmitted: false })} onSubmit={submitDiagnosis} onContinue={() => unlockStage("profile")} onBack={() => selectStage("onboarding")} />
      case "profile":
        return <ProfileScreen session={session} onContinue={() => unlockStage("plan")} onBack={() => selectStage("diagnosis")} />
      case "plan":
        return <PlanScreen session={session} onContinue={() => { setPreviewPlanId(null); unlockStage("learning") }} onPreview={() => { setPreviewPlanId(activePlan!.id); unlockStage("learning") }} onRetryGeneration={() => void retryGeneration()} onBack={() => selectStage("profile")} retrying={onboardingSubmittingPlanId === activePlan?.id} retryError={activePlan ? onboardingErrors[activePlan.id] ?? "" : ""} />
      case "learning":
        return <LearningScreen session={session} previewMode={previewMode} previewArtifacts={previewLearningArtifacts} hasDraftAnswers={previewMode ? false : hasUnsubmittedAssessmentDraft} saved={saved} anchorMode={previewMode ? false : Boolean(session.roleC?.routingRequestId)} anchorItemIds={session.roleC?.anchorItemIds ?? []} routing={routingPlanId === activePlan?.id} onTab={(activeArtifactKind) => updateView({ activeArtifactKind })} onCitation={(selectedSourceId) => updateView({ selectedSourceId, detailDrawer: "evidence" })} onAssessmentAnswer={(itemId, answer) => updateView({ assessmentAnswers: { ...(session.view.assessmentAnswers ?? {}), [itemId]: answer }, assessmentSubmitted: false, assessmentStatus: "idle", assessmentMessage: "" })} onAssessmentSubmit={previewMode ? () => undefined : submitAssessment} onRouteAnchors={routeAnchors} onContinue={() => unlockStage("feedback")} onBack={() => selectStage("plan")} />
      case "feedback":
        return <FeedbackScreen session={session} previewMode={previewMode} onRestart={() => updateView({ currentStage: "learning", activeArtifactKind: "lesson", remediationStarted: previewMode ? false : true })} onBack={() => selectStage("learning")} onContinueNextStage={() => void continueToNextStage()} continuing={continuingPlanId === activePlan?.id} continueError={activePlan ? onboardingErrors[activePlan.id] ?? "" : ""} />
    }
  }

  if (!activeUser) return <UserSetupScreen saved={saved} onCreate={(input) => {
    const user = createLocalLearner(input)
    setWorkspace({ ...workspace, activeUserId: user.id, activePlanId: null, users: [...workspace.users, user] })
  }} />

  if (!session || showPlanList) return <>
    {userSetupOpen ? (
      <UserSetupScreen saved={saved} canCancel onCancel={() => setUserSetupOpen(false)} onCreate={(input) => {
        const user = createLocalLearner(input)
        setWorkspace((current) => ({ ...current, activeUserId: user.id, activePlanId: null, users: [...current.users, user] }))
        setUserSetupOpen(false)
      }} />
    ) : (
      <>
    <PlanListScreen user={activeUser} plans={workspace.plans.filter((plan) => plan.userId === activeUser.id)} saved={saved} onCreate={() => setNewPlanOpen(true)} onOpen={(planId) => { setWorkspace((current) => selectPlan(current, planId)); setShowPlanList(false) }} onSwitchUser={() => setUserSwitcherOpen(true)} />
    {newPlanOpen && <NewPlanDialog user={activeUser} onCancel={() => setNewPlanOpen(false)} onCreate={createPlan} />}
    {userSwitcherOpen && <UserSwitcher users={workspace.users} activeUserId={activeUser.id} onClose={() => setUserSwitcherOpen(false)} onSelect={(userId) => { setWorkspace((current) => switchUser(current, userId)); setUserSwitcherOpen(false) }} onAdd={() => { setUserSwitcherOpen(false); setUserSetupOpen(true) }} />}
      </>
    )}
  </>

  const drawer = session.view.detailDrawer
  const includesRoleC = Boolean(session.roleC)
  const workflowLabel = session.planSource === "real-ab"
    ? includesRoleC ? "查看 A/B/C 执行链" : "查看 B/A 执行链"
    : "查看 Agent 协同"
  async function createPlan(input: NewLearningPlanInput & { title?: string }) {
    const plan = createLearningPlanDraft(input)
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
  const retryGeneration = async () => {
    if (!activePlan || !session) return
    const targetPlanId = activePlan.id
    setOnboardingSubmittingPlanId(targetPlanId)
    setOnboardingErrors((current) => ({ ...current, [targetPlanId]: "" }))
    try {
      const plan = await evaluatePlanDiagnosis(
        {
          source: "real-ab",
          input: { ...session.planInput, goal: session.profile.goal, selfRating: session.view.selfRatingDraft },
          diagnosis: {
            ...session.diagnosis,
            items: session.diagnosis.items ?? [],
            availability: session.diagnosis.availability ?? (session.diagnosis.items && session.diagnosis.items.length > 0 ? "available" : "unavailable"),
          },
          session,
        },
        session.view.diagnosisAnswers ?? {},
      )
      setWorkspace((current) => {
        if (!current.plans.some((candidate) => candidate.id === targetPlanId)) return current
        return {
          ...current,
          plans: current.plans.map((candidate) => candidate.id === targetPlanId
            ? {
                ...candidate,
                session: {
                  ...plan.session,
                  view: { ...plan.session.view, currentStage: "plan", maxUnlockedStage: "plan" },
                },
                updatedAt: new Date().toISOString(),
              }
            : candidate),
        }
      })
    } catch (error) {
      setOnboardingErrors((current) => ({ ...current, [targetPlanId]: error instanceof Error ? error.message : "无法重新生成学习资源，请稍后重试。" }))
    } finally {
      setOnboardingSubmittingPlanId((current) => current === targetPlanId ? null : current)
    }
  }
  const submitAssessment = async () => {
    if (!session || session.view.assessmentStatus === "submitting") return
    const targetPlanId = activePlan!.id
    const targetSessionId = session.sessionId
    const targetRunId = session.roleC?.runId
    updateView({ assessmentSubmitted: true, assessmentStatus: "submitting", assessmentMessage: "正在等待 C 正式评分…" })
    const result = await submitRoleCAssessment(session)
    setWorkspace((current) => ({
      ...current,
      plans: current.plans.map((candidate) => {
        if (candidate.id !== targetPlanId
          || candidate.session.sessionId !== targetSessionId
          || candidate.session.roleC?.runId !== targetRunId) return candidate
        return {
          ...candidate,
          session: applyRoleCSubmissionOutcome(candidate.session, result.submissionId, result.outcome),
          updatedAt: new Date().toISOString(),
        }
      }),
    }))
  }

  const continueToNextStage = async () => {
    if (!session || continuingPlanId !== null) return
    const targetPlanId = activePlan!.id
    const targetSessionId = session.sessionId
    const targetRunId = session.roleC?.runId
    if (!session.roleC?.submissionId) {
      setOnboardingErrors((current) => ({ ...current, [targetPlanId]: "缺少已完成的提交记录，无法进入下一阶段。请先完成整套测评提交。" }))
      return
    }
    setContinuingPlanId(targetPlanId)
    setOnboardingErrors((current) => ({ ...current, [targetPlanId]: "" }))
    try {
      const result = await continueRoleCAfterSubmission({
        sessionId: session.roleC.learningSessionId,
        submissionId: session.roleC.submissionId,
        learnerId: session.profile.learnerId,
      })
      if (result.status === "published") {
        const nextArtifacts = continuationToRoleDArtifacts(result.reviewedRelease)
        const nextWorkflow = continuationToRoleDWorkflow(result.reviewedRelease.trace_events)
        const nextSession = result.learningSession.session
        const anchorPending = nextSession.phase === "anchor_pending"
        setWorkspace((current) => ({
          ...current,
          plans: current.plans.map((candidate) => {
            if (candidate.id !== targetPlanId
              || candidate.session.sessionId !== targetSessionId
              || candidate.session.roleC?.runId !== targetRunId) return candidate
            const latest = candidate.session
            return {
              ...candidate,
              session: {
                ...latest,
                artifacts: nextArtifacts.length > 0 ? nextArtifacts : latest.artifacts,
                workflow: [...latest.workflow, ...nextWorkflow],
                roleC: {
                  runId: nextSession.run_id,
                  learningSessionId: nextSession.session_id,
                  formId: nextSession.form_id,
                  attemptNo: nextSession.attempt_no,
                  ...(anchorPending ? { routingRequestId: nextSession.routing_request_id, anchorItemIds: [...nextSession.required_item_ids] } : {}),
                },
                feedback: undefined,
                assessmentGraded: false,
                path: updatePath(latest.path, "advance"),
                view: {
                  ...latest.view,
                  currentStage: "learning",
                  activeArtifactKind: anchorPending ? "assessment" : "lesson",
                  assessmentAnswers: {},
                  assessmentSubmitted: false,
                  assessmentStatus: "idle",
                  assessmentMessage: anchorPending ? "请先完成锚点题，确定本轮测评路线。" : "",
                  remediationStarted: false,
                },
              },
              updatedAt: new Date().toISOString(),
            }
          }),
        }))
      } else if (result.status === "awaiting_input") {
        setOnboardingErrors((current) => ({ ...current, [targetPlanId]: `C 需要${result.requiredInputs.join("、")}才能规划下一阶段${result.action === "advance" ? "（进阶）" : "（重新校准）"}，请稍后再试。` }))
      } else {
        setOnboardingErrors((current) => ({ ...current, [targetPlanId]: result.reason ?? "C 未能完成下一阶段准备。" }))
      }
    } catch (error) {
      setOnboardingErrors((current) => ({ ...current, [targetPlanId]: error instanceof Error ? error.message : "无法进入下一阶段，请稍后重试。" }))
    } finally {
      setContinuingPlanId((current) => current === targetPlanId ? null : current)
    }
  }

  const routeAnchors = async () => {
    if (!session || routingPlanId !== null || !session.roleC?.routingRequestId) return
    const targetPlanId = activePlan!.id
    const targetSessionId = session.sessionId
    const targetRunId = session.roleC?.runId
    setRoutingPlanId(targetPlanId)
    setOnboardingErrors((current) => ({ ...current, [targetPlanId]: "" }))
    try {
      const result = await routeRoleCAssessmentAnchors({
        routingRequestId: session.roleC.routingRequestId,
        sessionId: session.roleC.learningSessionId,
        runId: session.roleC.runId,
        learnerId: session.profile.learnerId,
        formId: session.roleC.formId,
        attemptNo: session.roleC.attemptNo,
        submissionId: `SUB-ANCHOR-${Date.now()}`,
        answers: buildRoleCSubmissionAnswers(session)
          .filter((answer) => session.roleC?.anchorItemIds?.includes(answer.item_id)),
      })
      setWorkspace((current) => ({
        ...current,
        plans: current.plans.map((candidate) => {
          if (candidate.id !== targetPlanId
            || candidate.session.sessionId !== targetSessionId
            || candidate.session.roleC?.runId !== targetRunId) return candidate
          const latest = candidate.session
          if (result.status === "routed") {
            const locked = result.learning_session
            return {
              ...candidate,
              session: {
                ...latest,
                roleC: latest.roleC ? {
                  runId: locked.run_id,
                  learningSessionId: locked.session_id,
                  formId: locked.form_id,
                  attemptNo: locked.attempt_no,
                } : latest.roleC,
                view: {
                  ...latest.view,
                  activeArtifactKind: "assessment",
                  assessmentAnswers: {},
                  assessmentSubmitted: false,
                  assessmentStatus: "idle",
                  assessmentMessage: "测评路线已确定，请完成整套测评。",
                },
              },
              updatedAt: new Date().toISOString(),
            }
          }
          return {
            ...candidate,
            session: {
              ...latest,
              view: {
                ...latest.view,
                assessmentStatus: "blocked",
                assessmentMessage: result.status === "needs_review"
                  ? `锚点题 ${result.unresolved_anchor_item_ids.length} 道需要进一步审核。`
                  : `锚点路由失败：${(result as { issues?: string[] }).issues?.join("；") ?? "请重试。"}`,
              },
            },
            updatedAt: new Date().toISOString(),
          }
        }),
      }))
    } catch (error) {
      setOnboardingErrors((current) => ({ ...current, [targetPlanId]: error instanceof Error ? error.message : "锚点路由失败，请稍后重试。" }))
    } finally {
      setRoutingPlanId((current) => current === targetPlanId ? null : current)
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
      diagnosis: {
        ...session.diagnosis,
        availability: session.diagnosis.availability
          ?? (diagnosisItems(session.diagnosis).length > 0 ? "available" : "unavailable"),
        items: diagnosisItems(session.diagnosis),
      },
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

      {drawer === "agents" && <DetailDrawer title={session.planSource === "real-ab" ? includesRoleC ? "A/B/C 执行详情" : "B/A 执行详情" : "Agent 协同过程"} onClose={() => updateView({ detailDrawer: "none" })}><WorkflowTimeline events={session.workflow} localExecution={session.planSource === "real-ab"} includesRoleC={includesRoleC} /></DetailDrawer>}
      {drawer === "evidence" && <DetailDrawer title="知识证据与引用" onClose={() => updateView({ detailDrawer: "none" })}><EvidenceInspector items={session.retrieval.items} artifacts={session.artifacts} selectedSourceId={session.view.selectedSourceId} onSelect={(selectedSourceId) => updateView({ selectedSourceId })} /></DetailDrawer>}
      {deleteOpen && <ConfirmDialog title="删除当前学习计划？" description="这会删除当前计划的画像、资源、答案和学习进度，但不会影响该用户的其他计划。" confirmLabel="删除计划" onCancel={() => setDeleteOpen(false)} onConfirm={() => { setWorkspace((current) => deletePlan(current, activePlan!.id)); setDeleteOpen(false); setShowPlanList(true) }} />}
      {newPlanOpen && <NewPlanDialog user={activeUser} onCancel={() => setNewPlanOpen(false)} onCreate={createPlan} />}
    </div>
  )
}

function learnerLevelLabel(level: "beginner" | "basic" | "intermediate" | "integrated" | undefined): string {
  return level ? ({ beginner: "刚刚接触", basic: "有一点基础", intermediate: "可以独立编程", integrated: "能够综合运用" })[level] : "未填写"
}

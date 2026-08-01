import type { ArtifactKind, RoleDSession } from "../domain/types"
import { LearningWorkspace } from "../components/LearningWorkspace"

interface LearningScreenProps { session: RoleDSession; hasDraftAnswers: boolean; saved: boolean; previewMode?: boolean; previewArtifacts?: RoleDSession["artifacts"]; anchorMode?: boolean; anchorItemIds?: string[]; routing?: boolean; onTab: (kind: ArtifactKind) => void; onCitation: (sourceId: string) => void; onAssessmentAnswer: (itemId: string, answer: string) => void; onAssessmentSubmit: () => void; onRouteAnchors?: () => void; onContinue: () => void; onBack: () => void }

export function LearningScreen({ session, hasDraftAnswers, saved, previewMode = false, previewArtifacts, anchorMode = false, anchorItemIds = [], routing = false, onTab, onCitation, onAssessmentAnswer, onAssessmentSubmit, onRouteAnchors, onContinue, onBack }: LearningScreenProps) {
  const artifacts = previewMode ? previewArtifacts ?? [] : session.artifacts
  const realKinds = new Set(artifacts.filter((artifact) => artifact.status === "real").map((artifact) => artifact.kind))
  const contentReady = (["lesson", "lab", "assessment"] as const).every((kind) => realKinds.has(kind))
  return (
    <section className="stage-screen learning-screen">
      <div className="screen-heading"><span className="screen-step">学习流程 5 / 6 · 学习实操</span><h1>{anchorMode ? "先完成锚点题，确定本轮测评路线" : "按自己的节奏完成学习任务"}</h1><p>{anchorMode ? "C 需要先根据锚点题作答确定本轮测评的难度路线，之后才会解锁完整测评。" : "先理解概念，再完成代码实验，最后进入分阶测评。每项知识内容均可查看来源。"}</p></div>
      {previewMode && <p className="plan-blocked-note" role="status">界面预览 · 非审核正式资源 · 不产生 C 正式评分、掌握度或下一步决策</p>}
      <LearningWorkspace artifacts={artifacts} activeKind={session.view.activeArtifactKind} assessmentAnswers={session.view.assessmentAnswers ?? {}} assessmentSubmitted={previewMode ? false : session.view.assessmentSubmitted === true} assessmentStatus={previewMode ? "idle" : session.view.assessmentStatus} assessmentMessage={previewMode ? "" : session.view.assessmentMessage} anchorMode={anchorMode} anchorItemIds={anchorItemIds} routing={routing} onKindChange={onTab} onCitationSelect={onCitation} onAssessmentAnswer={onAssessmentAnswer} onAssessmentSubmit={onAssessmentSubmit} onRouteAnchors={onRouteAnchors} previewMode={previewMode} />
      {hasDraftAnswers && <p className={`learning-draft-notice${saved ? "" : " is-error"}`} role="status">{saved ? "答案已保存在当前计划；提交后才会进入正式评分。" : "答案仍在当前页面，但写入本机失败；请不要关闭页面，并优先导出进度。"}</p>}
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回方案</button><button className="primary-action" type="button" onClick={onContinue}>{previewMode ? "预览反馈调整界面" : contentReady ? "查看反馈状态" : "查看模拟反馈"}</button></div>
    </section>
  )
}

import type { ArtifactKind, RoleDSession } from "../domain/types"
import { LearningWorkspace } from "../components/LearningWorkspace"

interface LearningScreenProps { session: RoleDSession; onTab: (kind: ArtifactKind) => void; onCitation: (sourceId: string) => void; onContinue: () => void; onBack: () => void }

export function LearningScreen({ session, onTab, onCitation, onContinue, onBack }: LearningScreenProps) {
  const contentReady = session.artifacts.length === 3 && session.artifacts.every((artifact) => artifact.status === "real")
  return (
    <section className="stage-screen learning-screen">
      <div className="screen-heading"><span className="screen-step">学习流程 5 / 6 · 学习实操</span><h1>按自己的节奏完成学习任务</h1><p>先理解概念，再完成代码实验，最后进入分阶测评。每项知识内容均可查看来源。</p></div>
      <LearningWorkspace artifacts={session.artifacts} activeKind={session.view.activeArtifactKind} onKindChange={onTab} onCitationSelect={onCitation} />
      <div className="screen-actions"><button className="secondary-action" type="button" onClick={onBack}>返回方案</button><button className="primary-action" type="button" onClick={onContinue}>{contentReady ? "查看反馈状态" : "查看模拟反馈"}</button></div>
    </section>
  )
}

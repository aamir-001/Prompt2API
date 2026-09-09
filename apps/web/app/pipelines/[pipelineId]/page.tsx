import { PipelineConsole } from "../../../components/pipeline-console";

export default async function PipelinePage({
  params,
}: {
  params: Promise<{ pipelineId: string }>;
}) {
  const { pipelineId } = await params;
  return <PipelineConsole pipelineId={pipelineId} />;
}

import { DatasetConsole } from "../../../components/dataset-console";

export default async function DatasetPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <DatasetConsole slug={slug} />;
}

import neo4j from "neo4j-driver";

const driver = neo4j.driver(
  process.env.NEO4J_URI!,
  neo4j.auth.basic(process.env.NEO4J_USER!, process.env.NEO4J_PASSWORD!)
);

export async function runQuery(
  query: string,
  params: Record<string, any> = {}
) {
  const session = driver.session();
  try {
    const result = await session.run(query, params);
    return result.records.map((r) => r.toObject());
  } finally {
    await session.close();
  }
}

export default driver;
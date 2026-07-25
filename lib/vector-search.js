// lib/vector-search.js
//
// =============================================================================
// pgvector similarity search for the AI assistant RAG knowledge base.
//
// Queries the ai_knowledge_chunks table using pgvector cosine distance
// to find the most relevant text chunks for a given query embedding.
// =============================================================================

import { pool } from "../db/pool.js";

/**
 * Search the knowledge base for chunks similar to the query embedding.
 *
 * @param {object} opts
 * @param {number}   opts.assistantId    - The assistant config ID
 * @param {number[]} opts.queryEmbedding - 1536-dim float array (OpenAI text-embedding-3-small)
 * @param {number}   [opts.topK=5]       - Number of results to return
 * @returns {Promise<Array<{documentId: number, content: string, chunkIndex: number, distance: number}>>}
 */
export async function searchKnowledgeBase({ assistantId, queryEmbedding, topK = 5 }) {
  if (!assistantId || !Array.isArray(queryEmbedding) || queryEmbedding.length === 0) {
    return [];
  }

  // Format the embedding as a pgvector literal: '[0.1, 0.2, ...]'
  const embeddingLiteral = `[${queryEmbedding.join(",")}]`;

  try {
    const { rows } = await pool.query(
      `SELECT document_id,
              content,
              chunk_index,
              embedding <=> $1::vector AS distance
       FROM ai_knowledge_chunks
       WHERE assistant_id = $2
       ORDER BY distance ASC
       LIMIT $3`,
      [embeddingLiteral, assistantId, topK],
    );

    return rows.map((r) => ({
      documentId: Number(r.document_id),
      content: r.content,
      chunkIndex: Number(r.chunk_index),
      distance: Number(r.distance),
    }));
  } catch (err) {
    console.error("[vector-search]", err.code, err.message);
    return [];
  }
}

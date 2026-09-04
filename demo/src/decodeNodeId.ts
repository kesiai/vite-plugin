import { useEffect, useState } from 'react';

/**
 * 浏览器端安全的 data-node-id 解码器。
 * 与 @kesi/vite-plugin 导出的 decodeNodeId 格式一致（node- + base64url(JSON)），
 * 此处内联一份，避免在浏览器里引入插件 Node 端入口。
 */
export interface NodeSourceSpan {
  file: string;
  startLine: number;
  startCol: number;
  endLine: number;
  endCol: number;
}

const NODE_ID_PREFIX = 'node-';

function fromBase64Url(encoded: string): string {
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(padded, 'base64').toString('utf8');
  }
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

export function decodeNodeId(id: string | null | undefined): NodeSourceSpan | null {
  if (!id || !id.startsWith(NODE_ID_PREFIX)) return null;
  try {
    const parsed = JSON.parse(fromBase64Url(id.slice(NODE_ID_PREFIX.length)));
    if (
      typeof parsed?.file !== 'string' ||
      !Number.isFinite(parsed?.startLine) ||
      !Number.isFinite(parsed?.startCol) ||
      !Number.isFinite(parsed?.endLine) ||
      !Number.isFinite(parsed?.endCol)
    ) {
      return null;
    }
    return parsed as NodeSourceSpan;
  } catch {
    return null;
  }
}

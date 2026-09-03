import { canonicalJson } from "../../kernel/ids.js";
import { ConnectorError, type ConnectorKind } from "./types.js";

interface CursorEnvelope {
  readonly v: 1;
  readonly connector: ConnectorKind;
  readonly binding: string;
  readonly revision: number;
  readonly state: Readonly<Record<string, string>>;
}

export function encodeConnectorCursor(
  connector: ConnectorKind,
  bindingId: string,
  revision: number,
  state: Readonly<Record<string, string>>,
): string {
  const envelope: CursorEnvelope = { v: 1, connector, binding: bindingId, revision, state };
  return Buffer.from(canonicalJson(envelope), "utf8").toString("base64url");
}

export function decodeConnectorCursor(
  cursor: string | undefined,
  connector: ConnectorKind,
  bindingId: string,
  revision: number,
): Readonly<Record<string, string>> {
  if (cursor === undefined || cursor.trim() === "") return {};
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorEnvelope>;
    if (
      value.v !== 1 ||
      value.connector !== connector ||
      value.binding !== bindingId ||
      value.revision !== revision ||
      value.state === null ||
      typeof value.state !== "object" ||
      Array.isArray(value.state) ||
      Object.values(value.state).some((entry) => typeof entry !== "string")
    ) {
      throw new Error("cursor scope mismatch");
    }
    return value.state as Readonly<Record<string, string>>;
  } catch {
    throw new ConnectorError("INVALID_CURSOR", "同步游标无效或连接配置已经变化");
  }
}


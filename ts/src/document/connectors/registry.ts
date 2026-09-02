import { ConnectorError, type ConnectorKind, type DocumentSourceConnector } from "./types.js";

export class ConnectorRegistry {
  private readonly connectors = new Map<ConnectorKind, DocumentSourceConnector>();

  register(connector: DocumentSourceConnector): this {
    if (this.connectors.has(connector.kind)) {
      throw new ConnectorError("INVALID_BINDING", `连接器 ${connector.kind} 已注册`);
    }
    this.connectors.set(connector.kind, connector);
    return this;
  }

  get(kind: ConnectorKind): DocumentSourceConnector {
    const connector = this.connectors.get(kind);
    if (connector === undefined) {
      throw new ConnectorError("SOURCE_UNAVAILABLE", `连接器 ${kind} 尚未配置`);
    }
    return connector;
  }

  kinds(): readonly ConnectorKind[] {
    return [...this.connectors.keys()].sort();
  }
}


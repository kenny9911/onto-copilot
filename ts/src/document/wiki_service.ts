import type { DocumentScope } from "./types.js";
import { DocumentError, DocumentNotFound } from "./types.js";
import {
  buildObsidianVault,
  checkWikiMaterialFactSupport,
  confirmWikiClaim,
  createWikiClaimDraft,
  createWikiPage,
  renderWikiMarkdown,
  type ObsidianVaultBundle,
  type WikiActor,
  type WikiClaimDraftInput,
  type WikiClaimKind,
  type WikiEvidenceExcerpt,
} from "./wiki.js";
import {
  type StoredWikiPage,
  type WikiPageRepository,
  type WikiPageRevision,
} from "./wiki_repository.js";

export interface WikiDraftSpec {
  readonly kind: WikiClaimKind;
  readonly subject: string;
  readonly statement: string;
  readonly evidenceRefs?: readonly string[];
  readonly supersedesClaimId?: string;
}

export interface CreateWikiPageCommand {
  readonly id?: string;
  readonly title: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly drafts?: readonly WikiDraftSpec[];
  readonly actor: WikiActor;
}

export interface UpdateWikiPageCommand {
  readonly expectedRevision: number;
  readonly title?: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly actor: WikiActor;
}

export interface AddWikiDraftCommand extends WikiDraftSpec {
  readonly expectedRevision: number;
  readonly actor: WikiActor;
}

export interface EditWikiDraftCommand {
  readonly claimId: string;
  readonly expectedRevision: number;
  readonly kind?: WikiClaimKind;
  readonly subject?: string;
  readonly statement?: string;
  readonly evidenceRefs?: readonly string[];
  readonly actor: WikiActor;
}

export interface ConfirmWikiClaimCommand {
  readonly claimId: string;
  readonly expectedRevision: number;
  readonly evidenceRefs: readonly string[];
  readonly actor: WikiActor;
}

export interface ChangeWikiPageStatusCommand {
  readonly expectedRevision: number;
  readonly actor: WikiActor;
}

export type WikiClock = () => string;
export type WikiEvidenceResolver = (evidenceRef: string) => Promise<WikiEvidenceExcerpt>;

/**
 * 项目 Wiki 的唯一写入门面。模型不接触 repository 的整页快照写入：它只能调用
 * add/edit/removeDraft；确认、页面元数据和归档都要求 human actor。repository 仍会
 * 再做一次相同的状态迁移校验，防止未来的其他调用方绕过这层。
 */
export class WikiPageService {
  constructor(
    private readonly repository: WikiPageRepository,
    private readonly now: WikiClock = () => new Date().toISOString(),
  ) {}

  listPages(scope: DocumentScope, includeArchived = false): Promise<StoredWikiPage[]> {
    return this.repository.list(scope, includeArchived);
  }

  async getPage(scope: DocumentScope, pageId: string): Promise<StoredWikiPage> {
    const page = await this.repository.get(scope, pageId);
    if (page === null) throw new DocumentNotFound("没有找到这个 Wiki 页面");
    return page;
  }

  history(scope: DocumentScope, pageId: string): Promise<WikiPageRevision[]> {
    return this.repository.history(scope, pageId);
  }

  async createPage(scope: DocumentScope, command: CreateWikiPageCommand): Promise<StoredWikiPage> {
    const at = this.now();
    const drafts = (command.drafts ?? []).map((draft) => this.makeDraft(scope, draft, command.actor, at));
    const page = createWikiPage({
      ...(command.id === undefined ? {} : { id: command.id }),
      projectId: scope.projectId,
      title: command.title,
      ...(command.summary === undefined ? {} : { summary: command.summary }),
      ...(command.tags === undefined ? {} : { tags: command.tags }),
      claims: drafts,
      updatedAt: at,
    });
    return this.repository.create({ scope, page, actor: command.actor, createdAt: at });
  }

  /** 页面标题/摘要/标签属于人工维护信息；AI 只能改草稿声明。 */
  async updatePage(
    scope: DocumentScope,
    pageId: string,
    command: UpdateWikiPageCommand,
  ): Promise<StoredWikiPage> {
    this.requireHuman(command.actor, "只有真人可以修改 Wiki 页面标题、摘要或标签");
    const current = await this.getPage(scope, pageId);
    this.requireActive(current);
    const at = this.now();
    const page = createWikiPage({
      id: current.page.id,
      projectId: current.page.projectId,
      title: command.title ?? current.page.title,
      summary: command.summary ?? current.page.summary,
      tags: command.tags ?? current.page.tags,
      claims: current.page.claims,
      updatedAt: at,
    });
    return this.repository.commit({
      scope,
      pageId,
      expectedRevision: command.expectedRevision,
      page,
      status: current.status,
      action: "edit",
      actor: command.actor,
      recordedAt: at,
    });
  }

  async addDraft(
    scope: DocumentScope,
    pageId: string,
    command: AddWikiDraftCommand,
  ): Promise<StoredWikiPage> {
    const current = await this.getPage(scope, pageId);
    this.requireActive(current);
    const at = this.now();
    const claim = this.makeDraft(scope, command, command.actor, at);
    const page = createWikiPage({
      ...current.page,
      claims: [...current.page.claims, claim],
      updatedAt: at,
    });
    return this.repository.commit({
      scope,
      pageId,
      expectedRevision: command.expectedRevision,
      page,
      status: current.status,
      action: "edit",
      actor: command.actor,
      recordedAt: at,
    });
  }

  async editDraft(
    scope: DocumentScope,
    pageId: string,
    command: EditWikiDraftCommand,
  ): Promise<StoredWikiPage> {
    const current = await this.getPage(scope, pageId);
    this.requireActive(current);
    const old = current.page.claims.find((claim) => claim.id === command.claimId);
    if (old === undefined) throw new DocumentNotFound("没有找到这条 Wiki 声明");
    if (old.state !== "draft") {
      throw new DocumentError(
        "INVALID_ARGUMENT",
        "人工确认过的声明不可原地改写；请新增 contested/stale 草稿",
        400,
      );
    }
    const at = this.now();
    const replacement = createWikiClaimDraft({
      projectId: scope.projectId,
      kind: command.kind ?? old.kind,
      subject: command.subject ?? old.subject,
      statement: command.statement ?? old.statement,
      evidenceRefs: command.evidenceRefs ?? old.evidenceRefs,
      author: command.actor,
      createdAt: at,
      supersedesClaimId: old.id,
    });
    const page = createWikiPage({
      ...current.page,
      claims: current.page.claims.map((claim) => claim.id === old.id ? replacement : claim),
      updatedAt: at,
    });
    return this.repository.commit({
      scope,
      pageId,
      expectedRevision: command.expectedRevision,
      page,
      status: current.status,
      action: "edit",
      actor: command.actor,
      recordedAt: at,
    });
  }

  async removeDraft(
    scope: DocumentScope,
    pageId: string,
    claimId: string,
    command: { readonly expectedRevision: number; readonly actor: WikiActor },
  ): Promise<StoredWikiPage> {
    const current = await this.getPage(scope, pageId);
    this.requireActive(current);
    const old = current.page.claims.find((claim) => claim.id === claimId);
    if (old === undefined) throw new DocumentNotFound("没有找到这条 Wiki 声明");
    if (old.state !== "draft") {
      throw new DocumentError("INVALID_ARGUMENT", "人工确认过的声明不可删除", 400);
    }
    const at = this.now();
    const page = createWikiPage({
      ...current.page,
      claims: current.page.claims.filter((claim) => claim.id !== claimId),
      updatedAt: at,
    });
    return this.repository.commit({
      scope,
      pageId,
      expectedRevision: command.expectedRevision,
      page,
      status: current.status,
      action: "edit",
      actor: command.actor,
      recordedAt: at,
    });
  }

  async confirmClaim(
    scope: DocumentScope,
    pageId: string,
    command: ConfirmWikiClaimCommand,
    resolveEvidence?: WikiEvidenceResolver,
  ): Promise<StoredWikiPage> {
    this.requireHuman(command.actor, "只有真人可以确认 Wiki 声明");
    const current = await this.getPage(scope, pageId);
    this.requireActive(current);
    const old = current.page.claims.find((claim) => claim.id === command.claimId);
    if (old === undefined) throw new DocumentNotFound("没有找到这条 Wiki 声明");
    if (old.kind === "MATERIAL_FACT") {
      if (resolveEvidence === undefined) {
        throw new DocumentError(
          "INVALID_ARGUMENT",
          "材料事实必须先逐条打开原文，并确认原文确实支持这句话",
          422,
        );
      }
      const excerpts = await Promise.all(command.evidenceRefs.map(resolveEvidence));
      const support = checkWikiMaterialFactSupport(old.statement, excerpts);
      if (!support.supported) {
        throw new DocumentError(
          "INVALID_ARGUMENT",
          "所选原文虽然可以打开，但没有直接证明这句话。请换一条真正支持该结论的原文，或把它改成待确认推断。",
          422,
        );
      }
    }
    // HUMAN_DECISION 的权威来源是当前真人的确认动作。所附材料只是决策背景，
    // 不能因为词面不一致而否掉人的拍板，也不能借确认把 kind 改成 MATERIAL_FACT。
    const at = this.now();
    const confirmed = confirmWikiClaim(old, {
      actor: command.actor,
      evidenceRefs: command.evidenceRefs,
      confirmedAt: at,
    });
    const page = createWikiPage({
      ...current.page,
      claims: current.page.claims.map((claim) => claim.id === old.id ? confirmed : claim),
      updatedAt: at,
    });
    return this.repository.commit({
      scope,
      pageId,
      expectedRevision: command.expectedRevision,
      page,
      status: current.status,
      action: "confirm_claim",
      actor: command.actor,
      recordedAt: at,
    });
  }

  archivePage(
    scope: DocumentScope,
    pageId: string,
    command: ChangeWikiPageStatusCommand,
  ): Promise<StoredWikiPage> {
    return this.changeStatus(scope, pageId, command, "archive");
  }

  restorePage(
    scope: DocumentScope,
    pageId: string,
    command: ChangeWikiPageStatusCommand,
  ): Promise<StoredWikiPage> {
    return this.changeStatus(scope, pageId, command, "restore");
  }

  async renderMarkdown(scope: DocumentScope, pageId: string): Promise<string> {
    return renderWikiMarkdown((await this.getPage(scope, pageId)).page);
  }

  async buildObsidianVault(
    scope: DocumentScope,
    options: { readonly includeArchived?: boolean } = {},
  ): Promise<ObsidianVaultBundle> {
    const pages = await this.repository.list(scope, options.includeArchived === true);
    return buildObsidianVault({
      projectId: scope.projectId,
      pages: pages.map((item) => item.page),
      generatedAt: this.now(),
    });
  }

  private async changeStatus(
    scope: DocumentScope,
    pageId: string,
    command: ChangeWikiPageStatusCommand,
    action: "archive" | "restore",
  ): Promise<StoredWikiPage> {
    this.requireHuman(command.actor, "只有真人可以归档或恢复 Wiki 页面");
    const current = await this.getPage(scope, pageId);
    const at = this.now();
    const page = createWikiPage({ ...current.page, updatedAt: at });
    return this.repository.commit({
      scope,
      pageId,
      expectedRevision: command.expectedRevision,
      page,
      status: action === "archive" ? "archived" : "active",
      action,
      actor: command.actor,
      recordedAt: at,
    });
  }

  private makeDraft(
    scope: DocumentScope,
    input: WikiDraftSpec,
    actor: WikiActor,
    createdAt: string,
  ) {
    const claimInput: WikiClaimDraftInput = {
      projectId: scope.projectId,
      kind: input.kind,
      subject: input.subject,
      statement: input.statement,
      ...(input.evidenceRefs === undefined ? {} : { evidenceRefs: input.evidenceRefs }),
      author: actor,
      createdAt,
      ...(input.supersedesClaimId === undefined ? {} : { supersedesClaimId: input.supersedesClaimId }),
    };
    return createWikiClaimDraft(claimInput);
  }

  private requireHuman(actor: WikiActor, message: string): void {
    if (actor?.kind !== "human") throw new DocumentError("FORBIDDEN", message, 403);
  }

  private requireActive(page: StoredWikiPage): void {
    if (page.status !== "active") {
      throw new DocumentError("INVALID_ARGUMENT", "页面已归档；请先恢复再修改", 400);
    }
  }
}

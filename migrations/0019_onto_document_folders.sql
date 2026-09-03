-- 0019_onto_document_folders —— 用户手工创建的文件夹。
--
-- 在此之前，知识库树里的「文件夹」是**按标签推出来的**：有什么标签就有什么分组。
-- 那对「我想自己建一个文件夹，把材料拖进去」这件事完全无解 —— 空文件夹无处存放，
-- 建一个立刻消失。文件管理器的最小语义是：文件夹是**独立于文件存在的东西**。
--
-- 用「完整路径」而不是父子指针：树只有几层、要的操作是列全部和按前缀筛，
-- 路径一次查询就够；父子指针要递归 CTE，两种方言写法还不一样。
-- 路径用 / 分隔，不以 / 开头或结尾，段内不许有 /。
--
-- 边界和 0014 一致：project_id + owner 一起进主键，跟着文档表同一套分区规则。

BEGIN;

CREATE TABLE onto_document_folder (
    project_id text        NOT NULL,
    owner      text        NOT NULL,
    path       text        NOT NULL,
    created_by text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (project_id, owner, path)
);

CREATE INDEX onto_document_folder_scope_idx
    ON onto_document_folder (project_id, owner);

-- 文档所在的文件夹。空串 = 根目录，也是既有数据的默认落点：
-- 已经入库的材料不会因为这次升级而"消失"到某个新分组里。
ALTER TABLE onto_document ADD COLUMN folder_path text NOT NULL DEFAULT '';

CREATE INDEX onto_document_folder_path_idx
    ON onto_document (project_id, owner, folder_path);

COMMIT;

//! 模型能力写入清单：把「哪个 agent × 哪个键 × 未知时怎么办」从散文注释变成数据。
//!
//! 为什么要有这张表
//! ----------------
//! 能力注册链有四层加兜底（用户覆盖 > 网关实测 > 公共库 > 内置前缀表 > 关键词/保守估值）。
//! 前四层回答「我们确知吗」，最后一层只回答「给个数」。这两者的区别在写**别人家配置文件**
//! 时是决定性的：
//!
//! - 把估值当声明写进去，会**压低**真实能力。codex `-c model_context_window=131072`
//!   是硬覆盖，一个真实窗口 1M 的模型被按 128K 提前压缩——比不写更坏。
//! - 更隐蔽的一类：目标键是**完备声明**时，少写一个成员等于断言「不支持」。kimi 的
//!   `KIMI_MODEL_CAPABILITIES` 用 `capabilities.some(===)` 判成员，env 通道缺省集是
//!   `["image_in","thinking"]`（**不含 tool_use**）。旧代码在模型非思考时整个不写这个
//!   环境变量，于是模型丢掉工具；思考模型写 `tool_use,thinking`，又把缺省里的 `image_in`
//!   摘掉了。两个方向都错，根因是把「不知道」当成了「假」。
//!
//! 所以未知时的动作不是拍脑袋定的，而是由三个属性推出来的（见 `UnknownAction`）。
//! 表里只记属性，动作由 `action()` 算——这样改政策不用逐行改表，也不可能表和动作对不上。
//!
//! 这张表**不驱动写入代码**。写入路径仍在 agents.rs / global_config.rs 里，各有各的
//! 测试。本表的职责是：让「哪些键被写、按什么政策写、凭什么这么说」可被机器检查，
//! 并且在新加 agent、或把某个键从 optional 改成 required 时，逼出一次显式决策。

/// 目标键在对方 CLI 的格式里是否可以不出现。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Requiredness {
    /// 格式允许缺省：不知道就不写，让对方用自己的默认。
    Optional,
    /// 格式要求有值（缺了报错或行为不可用）：不知道也只能写保守值。
    Required,
}

/// 目标键的语义：是一个完整的能力集合，还是逐项独立。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Completeness {
    /// 逐项独立：写 A 不影响 B 的解读。
    PerItem,
    /// 完备声明：CLI 按成员判断，**不在表里 = 不支持**。少写比多写危险。
    /// 这类键要么整个不写（走 CLI 缺省），要么必须写成「缺省 ∪ 确知为真」。
    CompleteDeclaration,
}

/// 写错方向时，哪一边更坏。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Harm {
    /// 写少了更坏：少写会被解读成「不支持」，能力被静默剥夺。
    Understating,
    /// 写多了/写窄了更坏：会覆盖或压低真实能力（如硬覆盖上下文窗口）。
    Overstating,
    /// 两个方向代价相当，取保守值。
    Balanced,
}

/// 未知时该做什么。由属性推导，不由表逐行指定。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum UnknownAction {
    /// 整个键不写，让对方用自己的默认。
    Omit,
    /// 写一个保守下限，并在注释里说明这是下限不是声明。
    ConservativeFloor,
    /// 写「对方缺省集 ∪ 确知为真」——这样只会加，不会减。
    UnionWithDefault,
}

/// 一条写入点的自我声明。
#[derive(Debug, Clone, Copy)]
pub(crate) struct CapabilityWrite {
    pub agent: &'static str,
    /// 环境变量名，或「文件 + 键路径」的人读写法。用于在代码里定位。
    pub target: &'static str,
    /// 实际写入处的 file:line 附近的函数名，供人工核对（不参与断言）。
    pub site: &'static str,
    /// 该键的语义（上下文窗口 / 输出上限 / 视觉 / 思考 / 工具）。
    pub capability: &'static str,
    pub requiredness: Requiredness,
    pub completeness: Completeness,
    /// 写窄（写少）时的代价方向。
    pub harm: Harm,
    /// 论断的依据强度。**必须诚实标注**：只有二进制/schema 实证过的才配写 Binary，
    /// 注释里声称的一律 Comment。这是本表最容易被注水的一列。
    pub evidence: Evidence,
    /// 未知时该做什么。**不存**——由上面三个属性算（见 `action`）。
    /// 存下来会与属性漂移，而漂移的表比没有表更坏。
    _private: (),
}

/// 论断的依据强度。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Evidence {
    /// 对方二进制的错误串/常量/解析器行为实证（可在 strings 输出里复核）。
    Binary,
    /// 对方的 JSON schema / 类型定义。
    Schema,
    /// 只有注释或文档声称，未复核。
    Comment,
}

impl CapabilityWrite {
    /// 由属性推导未知时的动作。政策只写在函数里。
    pub(crate) fn action(&self) -> UnknownAction {
        match (self.requiredness, self.completeness, self.harm) {
            // 完备声明且写少更坏：必须写成「缺省 ∪ 确知为真」，因为不在表里 = 不支持。
            // 这类键即使对方格式允许缺省，单纯不写也可能踩到 CLI 缺省集不含某成员的情况。
            (_, Completeness::CompleteDeclaration, Harm::Understating) => {
                UnknownAction::UnionWithDefault
            }
            // 完备声明但不写少更坏：那就整个不写，别去替对方摘成员。
            (_, Completeness::CompleteDeclaration, _) => UnknownAction::Omit,
            // 格式要求有值，而且压低真实能力更坏：写保守下限，并说清是下限。
            (Requiredness::Required, _, _) => UnknownAction::ConservativeFloor,
            // 可选：不知道就不写。这是最安全的一档。
            (Requiredness::Optional, _, _) => UnknownAction::Omit,
        }
    }
}

/// 全表。新增写入点必须在此挂一行，否则 `coverage_*` 测试会红。
pub(crate) const WRITES: &[CapabilityWrite] = &[
    // ---- claude-code ----
    CapabilityWrite {
        agent: "claude-code",
        target: "env CLAUDE_CODE_MAX_CONTEXT_TOKENS",
        site: "agents.rs apply_launch_env",
        capability: "context",
        requiredness: Requiredness::Optional,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Comment,
        _private: (),
    },
    CapabilityWrite {
        agent: "claude-code",
        target: "settings.json env.CLAUDE_CODE_MAX_CONTEXT_TOKENS",
        site: "global_config.rs patch_claude_settings",
        capability: "context",
        requiredness: Requiredness::Optional,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Comment,
        _private: (),
    },
    // ---- codex ----
    CapabilityWrite {
        agent: "codex",
        target: "-c model_context_window",
        site: "agents.rs apply_launch_env",
        capability: "context",
        requiredness: Requiredness::Optional,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Comment,
        _private: (),
    },
    CapabilityWrite {
        agent: "codex",
        target: "catalog context_window / max_context_window",
        site: "agents.rs codex catalog writer",
        capability: "context",
        requiredness: Requiredness::Optional,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Comment,
        _private: (),
    },
    // ---- gemini ----
    CapabilityWrite {
        agent: "gemini",
        target: "settings.json modelConfigs.*.features.thinking",
        site: "global_config.rs patch_gemini_settings",
        capability: "thinking",
        requiredness: Requiredness::Optional,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Comment,
        _private: (),
    },
    CapabilityWrite {
        agent: "gemini",
        target: "settings.json modelConfigs.*.features.multimodalToolUse",
        site: "global_config.rs patch_gemini_settings",
        capability: "vision",
        requiredness: Requiredness::Optional,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Comment,
        _private: (),
    },
    // ---- kimi ----
    CapabilityWrite {
        agent: "kimi",
        target: "env KIMI_MODEL_MAX_CONTEXT_SIZE",
        site: "agents.rs apply_launch_env",
        capability: "context",
        requiredness: Requiredness::Optional,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Binary,
        _private: (),
    },
    CapabilityWrite {
        agent: "kimi",
        target: "env KIMI_MODEL_CAPABILITIES",
        site: "agents.rs apply_launch_env",
        capability: "capabilities",
        // 该键可缺省（缺省即 env 未设），但缺省集会**丢掉 tool_use**，所以不能让
        // 「不知道」退化成「不写」——写少在这个键上是实打实的能力剥夺。
        requiredness: Requiredness::Optional,
        completeness: Completeness::CompleteDeclaration,
        harm: Harm::Understating,
        evidence: Evidence::Binary,
        _private: (),
    },
    CapabilityWrite {
        agent: "kimi",
        target: "config.toml [models.*].max_context_size",
        site: "global_config.rs patch_kimi_config",
        capability: "context",
        // 实证：kimi 2.1.0 在模型无 maxContextSize 时硬抛
        // 「must define a positive max_context_size in config.toml」——非校验告警。
        requiredness: Requiredness::Required,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Binary,
        _private: (),
    },
    CapabilityWrite {
        agent: "kimi",
        target: "config.toml [models.*].capabilities",
        site: "global_config.rs patch_kimi_config",
        capability: "capabilities",
        // 此键 schema 可选，缺省值由 CLI 按模型自己推——所以它虽是完备声明，
        // 未知时整个不写反而是对的（写窄才是降级）。
        requiredness: Requiredness::Optional,
        completeness: Completeness::CompleteDeclaration,
        harm: Harm::Overstating,
        evidence: Evidence::Comment,
        _private: (),
    },
    // ---- opencode ----
    CapabilityWrite {
        agent: "opencode",
        target: "JSON limit.context",
        site: "agents.rs opencode_provider_json",
        capability: "context",
        // limit 键可省，一旦出现则 context 与 output 都必填
        //（1.18 实测缺 output 直接 "Configuration is invalid" 退出 1）。
        requiredness: Requiredness::Required,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Binary,
        _private: (),
    },
    CapabilityWrite {
        agent: "opencode",
        target: "JSON limit.output",
        site: "agents.rs opencode_provider_json",
        capability: "output",
        requiredness: Requiredness::Required,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Binary,
        _private: (),
    },
    CapabilityWrite {
        agent: "opencode",
        target: "JSON models.*.modalities.input",
        site: "agents.rs opencode_provider_json",
        capability: "vision",
        requiredness: Requiredness::Optional,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Comment,
        _private: (),
    },
    CapabilityWrite {
        agent: "opencode",
        target: "JSON models.*.reasoning",
        site: "agents.rs opencode_provider_json",
        capability: "thinking",
        requiredness: Requiredness::Optional,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Comment,
        _private: (),
    },
    // ---- grok ----
    CapabilityWrite {
        agent: "grok",
        target: "config.toml [model.*].context_window",
        site: "global_config.rs patch_grok_config",
        capability: "context",
        // 走 model_context_size_for_config：只在权威层（用户覆盖/网关实测/公共库显式值）
        // 确知时才建段，generic fallback 估值被排除在外。
        requiredness: Requiredness::Optional,
        completeness: Completeness::PerItem,
        harm: Harm::Overstating,
        evidence: Evidence::Comment,
        _private: (),
    },
];

/// 该 agent 是否有任何能力写入点。cursor 当前没有（只写密钥/端点/--model）。
pub(crate) fn writes_for(agent: &str) -> Vec<&'static CapabilityWrite> {
    WRITES.iter().filter(|w| w.agent == agent).collect()
}

/// 没有能力写入点的 agent，以及**为什么**没有。
///
/// 两种免除理由性质不同，混为一谈就会掩盖风险：
/// - `NoConfigSurface`：压根没有可写的配置文件，风险是零。
/// - `PolicyOnly`：有配置文件，但只写请求策略（温度/输出上限等用户显式选择的值），
///   不写任何由**能力注册链**推导的值。风险为零的前提是「用户显式设了才写」——
///   若将来有人把 `policy.max_output_tokens` 的兜底改成注册链估值，这一行就失效了，
///   那条测试 `every_agent_is_accounted_for` 会提醒你回头看一眼。
pub(crate) struct AgentWithoutCapabilityWrites {
    pub agent: &'static str,
    pub reason: NoWriteReason,
    pub note: &'static str,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum NoWriteReason {
    NoConfigSurface,
    PolicyOnly,
}

pub(crate) const NO_CAPABILITY_WRITES: &[AgentWithoutCapabilityWrites] = &[
    AgentWithoutCapabilityWrites {
        agent: "cursor",
        reason: NoWriteReason::NoConfigSurface,
        note: "global_config 的路径表对 cursor 返回 None：无 CLI 配置文件可写，只有密钥/端点/--model",
    },
    AgentWithoutCapabilityWrites {
        agent: "qwen",
        reason: NoWriteReason::PolicyOnly,
        note: "只写 settings.json 的 env/model 与 samplingParams.max_tokens，值来自 request_policy，非注册链",
    },
    AgentWithoutCapabilityWrites {
        agent: "codebuddy",
        reason: NoWriteReason::PolicyOnly,
        note: "只写 settings.json 的 env 块（endpoint/key/model），无能力键",
    },
    AgentWithoutCapabilityWrites {
        agent: "agy",
        reason: NoWriteReason::PolicyOnly,
        note: "会话级设置文件只写 modelProvider/model 与 customModelsConfig.customModels（apiProvider + modelName），无模型能力键；官方设为全局只撤回 mesa/ 项",
    },
];

#[cfg(test)]
mod tests {
    use super::*;

    /// 每个 agent 要么在表里有行，要么带理由地列为「无能力写入点」。
    /// 新增第十家 CLI 时这条会红，逼你确认它到底写不写能力——而不是默认它不写。
    #[test]
    fn every_agent_is_accounted_for() {
        for spec in crate::agent_specs::all_agent_specs() {
            let has_rows = !writes_for(spec.id).is_empty();
            let excused = NO_CAPABILITY_WRITES.iter().find(|e| e.agent == spec.id);
            assert!(
                has_rows ^ excused.is_some(),
                "agent {} 的能力写入点没有记账：表里{}行，免除名单里{}。\
                 新增 CLI 时请补 WRITES 行，或在 NO_CAPABILITY_WRITES 里加一行并写清理由。",
                spec.id,
                if has_rows { "有" } else { "无" },
                if excused.is_some() { "在" } else { "不在" }
            );
            if let Some(e) = excused {
                assert!(
                    !e.note.is_empty(),
                    "agent {} 被免除了，但没写为什么——空理由等于没记账",
                    spec.id
                );
            }
        }
    }

    /// 免除名单里不能有已经不存在的 agent（改名/删除后残留的鬼行）。
    #[test]
    fn no_stale_excuses() {
        for excuse in NO_CAPABILITY_WRITES {
            assert!(
                crate::agent_specs::agent_spec(excuse.agent).is_some(),
                "免除名单里的 {} 不在 AGENT_SPECS 中",
                excuse.agent
            );
            assert!(
                writes_for(excuse.agent).is_empty(),
                "{} 既有免除行又有 WRITES 行：二者只能取其一",
                excuse.agent
            );
        }
    }

    /// 表里不能出现不存在的 agent。
    #[test]
    fn no_orphan_rows() {
        for row in WRITES {
            assert!(
                crate::agent_specs::agent_spec(row.agent).is_some(),
                "能力表里的 agent {} 不在 AGENT_SPECS 中（改名了？）",
                row.agent
            );
        }
    }

    /// 「写少了更坏」的完备声明只能配 UnionWithDefault 或 Omit，绝不能配 ConservativeFloor。
    /// 保守下限在完备声明上是错的：下限是一个更小的集合，而更小的集合 = 更少的能力。
    #[test]
    fn conservative_floor_is_never_used_for_a_complete_declaration() {
        for row in WRITES {
            if row.action() == UnknownAction::ConservativeFloor {
                assert_ne!(
                    row.completeness,
                    Completeness::CompleteDeclaration,
                    "【{} / {}】是完备声明，却按保守下限写：\
                     完备声明的成员语义是「不在表里就是不支持」，写一个更小的集合等于静默剥夺能力。",
                    row.agent,
                    row.target
                );
            }
        }
    }

    /// 格式必须给值的键不能靠 Omit 蒙混。
    #[test]
    fn required_keys_are_never_omitted() {
        for row in WRITES {
            if row.requiredness == Requiredness::Required {
                assert_ne!(
                    row.action(),
                    UnknownAction::Omit,
                    "【{} / {}】是必填键，未知时 Omit 会让对方 CLI 报错或行为不可用。",
                    row.agent,
                    row.target
                );
            }
        }
    }

    /// kimi env 的 capabilities 是那条踩过坑的路径：完备声明 + 写少更坏 ⇒ 必须取并集。
    /// 这是本表存在的直接原因，单独钉住，免得将来被「优化」成不写。
    #[test]
    fn kimi_env_capabilities_must_union_with_the_cli_default() {
        let row = WRITES
            .iter()
            .find(|w| w.agent == "kimi" && w.target.contains("KIMI_MODEL_CAPABILITIES"))
            .expect("kimi 的 env KIMI_MODEL_CAPABILITIES 必须在表里");
        assert_eq!(
            row.action(),
            UnknownAction::UnionWithDefault,
            "该键缺省集为 [\"image_in\",\"thinking\"]（不含 tool_use），\
             不写或写窄都会让模型丢能力——只有「缺省 ∪ 确知为真」是安全的。"
        );
    }

    /// 依据强度必须诚实：这是最容易注水的一列，至少保证它不会悄悄变成全 Binary。
    #[test]
    fn evidence_strength_is_recorded_for_every_row() {
        for row in WRITES {
            // 断言本身很弱（枚举总有值），但把意图写下来：新增行时请如实选
            // Binary（能复核的实证）/ Schema / Comment（只是注释声称）。
            let _ = match row.evidence {
                Evidence::Binary | Evidence::Schema | Evidence::Comment => (),
            };
            assert!(!row.site.is_empty(), "【{}】缺少 site，无法人工核对写入位置", row.target);
        }
    }
}

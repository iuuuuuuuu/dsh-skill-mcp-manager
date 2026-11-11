window.__ModuleLoader__.load({ id: "dsh-skill-mcp-manager", factory: (require) => {

  // Pure-JS client bundle (no JSX/TS). Registers one "能力库 (Capability)"
  // settings section with 技能/MCP tabs. Talks to the host over same-origin
  // HTTP routes mounted by lib/ui.js.

  const React = require("react");
  const h = React.createElement;
  const { useState, useEffect, useCallback } = React;

  const name = "dsh-skill-mcp-manager";
  // Sidebar page id: the `main` panel key and the `sidebar.panellist` row id.
  const PANEL_ID = "skill-mcp-manager";
  const inject = ["slots"];

  // ── fetch ────────────────────────────────────────────────────────────────
  async function getJson(path) {
    const res = await fetch(path, { cache: "no-store" });
    const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
    if (!res.ok) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  async function postJson(path, body) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      body: JSON.stringify(body ?? {}),
    });
    const data = await res.json().catch(() => ({ ok: false, error: "HTTP " + res.status }));
    if (!res.ok || data.ok === false) throw new Error(data.error || "HTTP " + res.status);
    return data;
  }

  function cx() {
    return Array.prototype.filter.call(arguments, Boolean).join(" ");
  }

  function errText(error) {
    return String(error && error.message ? error.message : error);
  }

  // ── primitives ───────────────────────────────────────────────────────────
  function Switch(props) {
    const checked = props.checked === true;
    const disabled = props.disabled === true;
    return h("button", {
      type: "button",
      role: "switch",
      "aria-checked": checked ? "true" : "false",
      className: cx("smx-switch", checked && "is-on"),
      disabled,
      onClick: () => props.onChange(!checked),
    }, h("span", { className: "smx-switch__knob" }));
  }

  function Badge(props) {
    return h("span", { className: cx("smx-badge", props.tone ? "smx-badge--" + props.tone : "") }, props.children);
  }

  function Notice(props) {
    return h("div", { className: cx("smx-notice", props.kind ? "smx-notice--" + props.kind : "") },
      h("span", null, props.children),
      props.onDismiss
        ? h("button", { type: "button", className: "smx-notice__close", onClick: props.onDismiss }, "\u00d7")
        : null,
    );
  }

  function Empty(props) {
    return h("div", { className: "smx-empty" }, props.children);
  }

  // ── legacy session notice ────────────────────────────────────────────────
  // Sessions written before 1.1.5 cannot be opened once DSH reaches 2.0.9. The
  // host scans for them on every start while its `check` flag is set, reports the
  // count, and retires the flag by itself once a scan finds nothing. This only
  // points at the repair guide — nothing here repairs anything, and there is no
  // dismiss: an accidental click must not be able to hide a real problem.
  const REPAIR_GUIDE_URL = "https://github.com/alone-tree/dsh-skill-mcp-manager/issues/2";
  const AUDIT_POLL_MS = 5000;
  const AUDIT_POLL_LIMIT = 36;

  // The host reports a running scan explicitly, and the answer may take tens of
  // seconds on a large library, so poll while either is unsettled. A settled
  // check never polls at all.
  function useLegacyAudit() {
    const [audit, setAudit] = useState(null);
    useEffect(() => {
      let cancelled = false;
      let timer = null;
      let attempts = 0;
      const load = async () => {
        try {
          const data = await getJson("/skill-mcp-manager/session-audit");
          if (cancelled) return;
          setAudit(data);
          const unsettled = data.scanning === true || data.affected > 0;
          if (unsettled && attempts < AUDIT_POLL_LIMIT) {
            attempts += 1;
            timer = setTimeout(load, AUDIT_POLL_MS);
          }
        } catch {
          /* advisory only — a failed fetch stays silent */
        }
      };
      load();
      return () => {
        cancelled = true;
        if (timer !== null) clearTimeout(timer);
      };
    }, []);
    return audit;
  }

  function legacySessionsOpen(audit) {
    return audit !== null && audit.scanning !== true && audit.check !== false && audit.affected > 0;
  }

  function auditScanning(audit) {
    return audit !== null && audit.scanning === true;
  }

  // The result is told once per browser session, and the fact that it was told
  // is remembered in sessionStorage rather than on the host — a plugin whose one
  // job here is telling the user something should not grow a state file and a
  // write route to remember that the telling happened.
  //
  // The wait notice and the result toast need separate keys, because they are
  // separate conditions rather than one shared "already told" flag: they used to
  // share one, and closing the wait notice then counted as having told the
  // result, so the result was never shown at all (found on-machine 2026-09-14).
  const CHECK_TOAST_KEY = "dsh-skill-mcp-manager:checking-seen";
  const RESULT_TOAST_KEY = "dsh-skill-mcp-manager:result-shown";

  function sessionRemember(key) {
    try {
      window.sessionStorage.setItem(key, "1");
    } catch {
      /* a browser that refuses storage just shows the notice again */
    }
  }

  function sessionSeen(key) {
    try {
      return window.sessionStorage.getItem(key) === "1";
    } catch {
      return false;
    }
  }

  // The settled answer of a scan that ran in this process, told once for this
  // browser session. `checked` is what makes the difference between news and an
  // old conclusion: a retired check reads its record off disk on every start, and
  // announcing that as a result is what made "没有会话受影响" re-appear on every
  // restart (2026-09-14, on-machine). The banner does not use this at all: while
  // the check is open and something is affected it stays on screen.
  function auditResultShown(audit) {
    if (audit === null || audit.done !== true || audit.checked !== true || auditScanning(audit)) return false;
    return !sessionSeen(RESULT_TOAST_KEY);
  }

  // The banner is dismissed for the session, and — the mistake above — that must
  // not read as the result having been told.
  function bannerAvailable(audit) {
    return legacySessionsOpen(audit);
  }

  // Settings-page banner: the full explanation and the report to hand to an AI.
  // Whether it appears is decided by the host state alone — the check is open and
  // something is affected — so it comes back with the page and leaves only when
  // the problem is dealt with. Its close hides it just for this mount.
  function LegacySessionBanner() {
    const audit = useLegacyAudit();
    const [closed, setClosed] = useState(false);
    if (closed || !bannerAvailable(audit)) return null;
    return h(Notice, { kind: "error", onDismiss: () => {
      setClosed(true);
    } },
      h("span", { className: "smx-legacy" },
        h("span", { className: "smx-legacy__title" }, `因 DSH 版本升级，有 ${audit.affected} 个历史会话无法查看`),
        h("span", null,
          "DSH 升级后调整了 MCP 注入消息的格式规范，旧会话的 MCP 注入消息不再被支持，打开时会显示",
          h("code", { className: "smx-legacy__code" }, "历史加载失败：failed to observe session … cannot safely transform unclassified message source"),
          "。把上面这段报错交给 AI，让它去修；插件的提示里不含修复操作，详情见",
          h("a", { className: "smx-legacy__link", href: REPAIR_GUIDE_URL, target: "_blank", rel: "noreferrer" }, "本项目 issue"),
        ),
        h("span", { className: "smx-legacy__note" },
          "修好后不需要手动关闭：下次启动扫描到 0 会自动停止。若你决定不修复这些会话，把 ",
          h("code", { className: "smx-legacy__code" }, "~/.dsh/skill-mcp-manager/session-audit.json"),
          " 里的 ",
          h("code", { className: "smx-legacy__code" }, `"check": false`),
          " 写入即可停止提示。",
        ),
      ),
    );
  }

  // One toast per state. While the check runs it says so and asks for patience;
  // when the answer lands it replaces that with the result — a problem to hand
  // to an AI, or an all-clear. Closing the wait notice does not stop the check,
  // so the result still gets its turn.
  //
  // Closing goes through sessionStorage for both, so a closed notice stays
  // closed after a reload — and, because the two keys differ, closing the wait
  // notice can no longer swallow the result.
  function LegacySessionOverlay() {
    const audit = useLegacyAudit();
    // Closing writes to sessionStorage, not to React state, so it has to force a
    // render to take effect.
    const [, setTick] = useState(0);
    const checking = auditScanning(audit);
    const shown = auditResultShown(audit);
    if (checking && !sessionSeen(CHECK_TOAST_KEY)) {
      return h("div", { className: "smx-toast smx-toast--checking", role: "status" },
        h("div", { className: "smx-toast__main" },
          h("div", { className: "smx-toast__title" }, "因 DSH 版本升级，历史会话可能无法打开，能力库正在检查"),
          h("div", { className: "smx-toast__text" }, "若历史会话较多，可能需要一些时间，请耐心等待；检查期间历史会话目录可能暂时无法查看。本检查是一次性临时动作，修复后不会再次出现。"),
        ),
        h("button", {
          type: "button",
          className: "smx-toast__close",
          title: "本次不再显示",
          onClick: () => {
            sessionRemember(CHECK_TOAST_KEY);
            setTick((value) => value + 1);
          },
        }, "\u00d7"),
      );
    }
    if (shown) {
      const affected = audit.affected;
      return h("div", { className: "smx-toast" + (affected > 0 ? " smx-toast--alert" : " smx-toast--ok"), role: "status" },
        h("div", { className: "smx-toast__main" },
          h("div", { className: "smx-toast__title" }, affected > 0
            ? `因 DSH 版本升级，有 ${affected} 个历史会话无法查看`
            : "没有会话受影响，请放心使用"),
          h("div", { className: "smx-toast__text" }, affected > 0
            ? "把报错交给 AI，让它去修；详情见「设置 → 能力库」。"
            : "历史会话检查已完成，以后不会再检查。"),
        ),
        h("button", {
          type: "button",
          className: "smx-toast__close",
          title: affected > 0 ? "本次不再显示" : "知道了",
          onClick: () => {
            sessionRemember(RESULT_TOAST_KEY);
            setTick((value) => value + 1);
          },
        }, "\u00d7"),
      );
    }
    return null;
  }

  function kv(key, value) {
    return h("div", { className: "smx-kv", key },
      h("span", { className: "smx-kv__k" }, key),
      h("span", { className: "smx-kv__v" }, value === null || value === undefined || value === "" ? "\u2014" : String(value)),
    );
  }

  // ── Skills panel ─────────────────────────────────────────────────────────
  // Cards, not rows. Each skill is one self-contained tile: its identity, its
  // path and whether the model can see it are readable without reading across a
  // table, and the actions belong to the tile they act on.
  // Grouping keys. The host sends `origin`; when it does not (a newer client
  // against an older host — the desktop shell can reload the client bundle
  // without restarting the host), derive the same answer from the provider: a
  // named provider is a plugin, `filesystem` / this plugin's own recursive scan
  // are the user's own directories.
  const SYSTEM_SKILL_PROVIDERS = { "": true, filesystem: true, "skill-mcp-manager-recursive": true };
  const PACKAGE_IN_PATH_RE = /[\\/](?:app\.asar[^\\/]*|node_modules)[\\/]((?:@[^\\/]+[\\/])?[^\\/]+)/;

  function originOf(skill) {
    if (skill.origin && typeof skill.origin === "object") return skill.origin;
    const provider = typeof skill.provider === "string" ? skill.provider : "";
    const path = typeof skill.path === "string" ? skill.path : "";
    if (SYSTEM_SKILL_PROVIDERS[provider] === true) {
      return { kind: "system", key: "system", label: "系统", provider, package: null, runtime: false };
    }
    const match = PACKAGE_IN_PATH_RE.exec(path);
    return {
      kind: "plugin",
      key: provider,
      label: provider,
      provider,
      package: match === null ? null : match[1].replace(/[\\/]/g, "/"),
      runtime: /dsh-acl-skill-/.test(path),
    };
  }

  function SkillsPanel() {
    const [skills, setSkills] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [confirming, setConfirming] = useState("");
    // Which groups are unfolded. A missing key means "the default": 系统 is open,
    // every plugin group starts folded — a plugin's skills are the exception,
    // not the list the user came for.
    const [openGroups, setOpenGroups] = useState({});
    const [busyGroup, setBusyGroup] = useState("");

    const refresh = useCallback(async () => {
      setLoading(true);
      setError("");
      try {
        const data = await getJson("/skill-mcp-manager/skills");
        setSkills(data.skills || []);
      } catch (err) {
        setError(errText(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { refresh(); }, [refresh]);

    async function toggle(skill) {
      try {
        await postJson("/skill-mcp-manager/skills/toggle", { name: skill.name, enabled: !skill.modelInvocable });
        setSkills((current) => current && current.map((item) =>
          item.name === skill.name ? { ...item, modelInvocable: !skill.modelInvocable } : item,
        ));
      } catch (err) {
        setError(errText(err));
      }
    }

    async function open(skill) {
      try {
        await postJson("/skill-mcp-manager/skills/open", { name: skill.name });
        setNotice("已用系统编辑器打开 " + skill.path);
      } catch (err) {
        setError(errText(err) + " \u2014 " + skill.path);
      }
    }

    async function remove(skill) {
      setConfirming("");
      try {
        await postJson("/skill-mcp-manager/skills/delete", { name: skill.name });
        setNotice("已删除 " + skill.name);
        await refresh();
      } catch (err) {
        setError(errText(err));
      }
    }

    // The group switch is one write per skill on the host; read-only (shipped)
    // skills are reported back instead of being written, so a package we cannot
    // touch never looks switched off.
    async function toggleGroup(group, enabled) {
      setBusyGroup(group.key);
      try {
        let data;
        try {
          data = await postJson("/skill-mcp-manager/skills/toggle-group", { provider: group.provider, enabled });
        } catch (groupError) {
          // Older hosts have no batch route: do the same work one skill at a time
          // instead of leaving the switch dead.
          const updatedItems = [];
          const skippedItems = [];
          for (const skill of group.skills) {
            if (skill.readonly) {
              skippedItems.push(skill.name);
              continue;
            }
            await postJson("/skill-mcp-manager/skills/toggle", { name: skill.name, enabled });
            updatedItems.push({ name: skill.name, modelInvocable: enabled });
          }
          if (updatedItems.length === 0 && skippedItems.length === 0) throw groupError;
          data = { updated: updatedItems, skipped: skippedItems };
        }
        const updated = new Map((data.updated || []).map((item) => [item.name, item.modelInvocable]));
        setSkills((current) => current && current.map((item) =>
          updated.has(item.name) ? { ...item, modelInvocable: updated.get(item.name) } : item));
        const skipped = (data.skipped || []).length;
        setNotice("已" + (enabled ? "开启 " : "关闭 ") + group.title + " 下的 " + updated.size + " 个技能"
          + (skipped > 0 ? "（" + skipped + " 个随包只读，未改动）" : ""));
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusyGroup("");
      }
    }

    function mark(skill) {
      const letters = skill.name.replace(/[^A-Za-z0-9]/g, "").slice(0, 2).toUpperCase();
      return letters === "" ? "\u00b7\u00b7" : letters;
    }

    function skillCard(skill) {
      return h("article", {
        key: skill.name,
        className: cx("smx-card", skill.readonly && "is-readonly", !skill.modelInvocable && "is-dimmed"),
      },
        h("div", { className: "smx-card__head" },
          h("span", { className: "smx-mark" }, mark(skill)),
          h("div", { className: "smx-card__ident" },
            h("span", { className: "smx-card__name", title: skill.name }, skill.name),
            h("span", { className: "smx-card__sub", title: skill.path }, skill.path),
          ),
          skill.readonly ? h(Badge, { tone: "muted" }, "只读") : null,
        ),
        h("p", { className: cx("smx-card__desc", !skill.description && "is-empty") },
          skill.description ? skill.description : "这个技能没有写描述"),
        h("div", { className: "smx-card__foot" },
          skill.readonly
            ? h("span", { className: "smx-card__hint" }, "shipped 技能，只能查看")
            : h("label", { className: "smx-switchline" },
                h(Switch, { checked: skill.modelInvocable, onChange: () => toggle(skill) }),
                h("span", { className: "smx-switchline__label" }, skill.modelInvocable ? "模型可见" : "模型隐藏"),
              ),
          h("div", { className: "smx-card__actions" },
            h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => open(skill) }, "打开"),
            skill.readonly
              ? null
              : confirming === skill.name
                ? h("span", { className: "smx-confirm" },
                    h("button", { type: "button", className: "smx-btn smx-btn--danger", onClick: () => remove(skill) }, "确认删除整个文件夹"),
                    h("button", { type: "button", className: "smx-btn", onClick: () => setConfirming("") }, "取消"),
                  )
                : h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => setConfirming(skill.name) }, "删除"),
          ),
        ),
      );
    }

    // The host decides the group (provider name); the client only orders them and
    // remembers which are folded.
    const groups = [];
    {
      const byKey = new Map();
      for (const skill of skills || []) {
        const origin = originOf(skill);
        let group = byKey.get(origin.key);
        if (group === undefined) {
          group = {
            key: origin.key,
            kind: origin.kind || "system",
            label: origin.label || origin.key,
            provider: origin.provider || "",
            title: origin.kind === "plugin" ? "插件 \u00b7 " + (origin.package || origin.label || origin.key) : "系统",
            packageName: origin.package || null,
            runtime: origin.runtime === true,
            skills: [],
          };
          byKey.set(origin.key, group);
          groups.push(group);
        }
        group.skills.push(skill);
      }
      groups.sort((a, b) => (a.kind === b.kind ? String(a.label).localeCompare(String(b.label)) : a.kind === "system" ? -1 : 1));
    }

    const sections = groups.map((group) => {
      const unfolded = openGroups[group.key] !== undefined ? openGroups[group.key] : group.kind === "system";
      const writable = group.skills.filter((skill) => !skill.readonly);
      const enabled = group.skills.filter((skill) => skill.modelInvocable).length;
      return h("section", { key: group.key, className: cx("smx-group", "smx-group--" + group.kind) },
        h("div", { className: "smx-group__head" },
          h("button", {
            type: "button",
            className: "smx-group__toggle",
            "aria-expanded": unfolded ? "true" : "false",
            onClick: () => setOpenGroups((current) => ({ ...current, [group.key]: !unfolded })),
          },
            h("span", { className: cx("smx-group__chevron", unfolded && "is-open") }, "\u25b8"),
            h("span", { className: "smx-group__title" }, group.title),
            h("span", { className: "smx-group__count" }, group.skills.length + " 个 \u00b7 开启 " + enabled),
            group.kind !== "system" && group.packageName && group.packageName !== group.label
              ? h("span", { className: "smx-group__sub" }, group.label)
              : null,
            group.runtime ? h(Badge, { tone: "muted" }, "运行时生成") : null,
          ),
          group.kind === "system"
            ? null
            : h("span", { className: "smx-group__switch" },
                h(Switch, {
                  checked: enabled > 0,
                  disabled: busyGroup === group.key || writable.length === 0,
                  onChange: (next) => toggleGroup(group, next),
                }),
                h("span", { className: "smx-switchline__label" },
                  writable.length === 0
                    ? "随包只读"
                    : enabled === 0
                      ? "全部关闭"
                      : enabled === group.skills.length
                        ? "全部开启"
                        : "部分开启"),
              ),
        ),
        unfolded ? h("div", { className: "smx-cards" }, group.skills.map(skillCard)) : null,
      );
    });

    return h("div", { className: "smx" },
      h("div", { className: "smx-head" },
        h("span", { className: "smx-count" }, skills
          ? String(skills.length) + " 个技能 \u00b7 模型可见 " + skills.filter((s) => s.modelInvocable).length + " 个"
            + (groups.length > 1 ? " \u00b7 " + (groups.length - 1) + " 个插件分组" : "")
          : ""),
        h("button", { type: "button", className: "smx-btn", onClick: refresh }, "刷新"),
      ),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      loading ? h(Empty, null, "加载中\u2026")
        : skills && skills.length === 0 ? h(Empty, null, "没有可管理的技能（bundle 型 SKILL.md）")
        : h("div", { className: "smx-groups" }, sections),
    );
  }

  // ── MCP panel ────────────────────────────────────────────────────────────
  // One card per server. The card answers three questions without opening
  // anything: what tier is it, does it still connect, and how many tools does it
  // expose. Details (env/headers/tools/instructions) moved into a side drawer so
  // a long config cannot stretch a tile across the grid.
  const TIERS = ["eager", "on-demand", "disabled"];
  const TIER_LABEL = { "eager": "常驻", "on-demand": "按需", "disabled": "关闭" };
  const TIER_TONE = { "eager": "success", "on-demand": "info", "disabled": "muted" };
  // A card click must not start ten stdio processes at once; three at a time is
  // fast enough to feel like one action and gentle enough not to stall a host.
  const CHECK_CONCURRENCY = 3;

  function formatMs(value) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "\u2014";
    return value < 1000 ? Math.round(value) + " ms" : (value / 1000).toFixed(1) + " s";
  }

  function relativeTime(iso) {
    if (typeof iso !== "string" || iso === "") return "";
    const at = Date.parse(iso);
    if (!Number.isFinite(at)) return "";
    const delta = Date.now() - at;
    if (delta < 60000) return "刚刚";
    if (delta < 3600000) return Math.floor(delta / 60000) + " 分钟前";
    if (delta < 86400000) return Math.floor(delta / 3600000) + " 小时前";
    return Math.floor(delta / 86400000) + " 天前";
  }

  function McpPanel() {
    const [entries, setEntries] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState("");
    const [notice, setNotice] = useState("");
    const [reveal, setReveal] = useState(false);
    const [detail, setDetail] = useState("");
    const [confirming, setConfirming] = useState("");
    const [output, setOutput] = useState("");
    const [checks, setChecks] = useState({});
    const [progress, setProgress] = useState({ done: 0, total: 0 });
    const [testingAll, setTestingAll] = useState(false);
    const [toolDescMax, setToolDescMax] = useState(150);
    const [toolDescDraft, setToolDescDraft] = useState("150");
    const [bufferMb, setBufferMb] = useState(null);
    const [bufferDraft, setBufferDraft] = useState("");
    const [advanced, setAdvanced] = useState(false);
    // Plugin-contributed MCP rows come from the live loader (not the registry):
    // `native` is that list, `openGroups` folds their per-plugin groups (folded
    // by default, like the skill groups), `busyNative` marks the switch in flight.
    const [native, setNative] = useState({ supported: false, entries: [] });
    const [openGroups, setOpenGroups] = useState({});
    const [busyNative, setBusyNative] = useState("");

    const refresh = useCallback(async (rv) => {
      setLoading(true);
      setError("");
      try {
        const data = await getJson("/skill-mcp-manager/mcp" + (rv ? "?reveal=1" : ""));
        setEntries(data.entries || []);
        setNative(data.native || { supported: false, entries: [] });
      } catch (err) {
        setError(errText(err));
      } finally {
        setLoading(false);
      }
    }, []);

    useEffect(() => { refresh(false); }, [refresh]);

    useEffect(() => {
      getJson("/skill-mcp-manager/settings")
        .then((data) => {
          const value = data.toolDescriptionMaxLength;
          if (typeof value === "number" && value > 0) {
            setToolDescMax(value);
            setToolDescDraft(String(value));
          }
          const mb = data.stdioMaxBufferSizeMb;
          if (typeof mb === "number" && mb > 0) {
            setBufferMb(mb);
            setBufferDraft(String(mb));
          }
        })
        .catch(() => {});
    }, []);

    async function saveToolDesc() {
      const value = Number(toolDescDraft);
      if (!Number.isInteger(value) || value <= 0 || value > 5000) {
        setError("工具描述截断必须是 1\u20135000 的正整数");
        return;
      }
      try {
        await postJson("/skill-mcp-manager/settings", { toolDescriptionMaxLength: value });
        setToolDescMax(value);
        setNotice("已更新工具描述截断为 " + value);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function saveBufferMb() {
      const text = bufferDraft.trim();
      // Empty clears the override (back to the SDK default of 10 MB).
      const value = text === "" ? null : Number(text);
      if (value !== null && (!Number.isInteger(value) || value <= 0)) {
        setError("stdio 消息上限必须是正整数（MB），留空表示使用 SDK 默认 10 MB");
        return;
      }
      try {
        await postJson("/skill-mcp-manager/settings", { stdioMaxBufferSizeMb: value });
        setBufferMb(value);
        setBufferDraft(value === null ? "" : String(value));
        setNotice(value === null
          ? "已恢复 SDK 默认上限 10 MB；新上限对之后 mcp_load 的连接生效"
          : "已把 stdio 消息上限调到 " + value + " MB；对之后 mcp_load 的连接生效");
      } catch (err) {
        setError(errText(err));
      }
    }

    async function toggleReveal() {
      const next = !reveal;
      setReveal(next);
      await refresh(next);
    }

    async function setTier(entry, tier) {
      try {
        const upgrading = entry.tier === "on-demand" && tier === "eager";
        await postJson("/skill-mcp-manager/mcp/tier", { name: entry.name, tier });
        setNotice(upgrading ? "已升至 eager（运行中注册，前缀失效一次）" : "已切换 \u300c" + entry.name + "\u300d 到 " + tier);
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function setToolEnabled(entry, tool, enabled) {
      try {
        await postJson("/skill-mcp-manager/mcp/tool-tier", {
          name: entry.name,
          tool: tool.name,
          enabled,
        });
        setNotice("已" + (enabled ? "启用 " : "禁用 ") + entry.name + "/" + tool.name);
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function run(entry, peek) {
      setOutput("");
      try {
        const data = await postJson("/skill-mcp-manager/mcp/load", { name: entry.name, peek: peek === true });
        setOutput(data.text || "");
        setNotice(peek ? "已查看描述" : "已刷新快照");
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    async function remove(entry) {
      setConfirming("");
      try {
        await postJson("/skill-mcp-manager/mcp/delete", { name: entry.name });
        setNotice("已删除 " + entry.name);
        setDetail("");
        setOutput("");
        await refresh(reveal);
      } catch (err) {
        setError(errText(err));
      }
    }

    // A check is a real handshake on a short timeout, so the answer is what the
    // server just said — not what a snapshot from weeks ago claims.
    async function checkOne(entry) {
      setChecks((current) => ({ ...current, [entry.name]: { status: "running" } }));
      try {
        const data = await postJson("/skill-mcp-manager/mcp/test", { name: entry.name });
        const check = data.check || {};
        setChecks((current) => ({
          ...current,
          [entry.name]: {
            status: check.ok === true ? "ok" : "fail",
            latencyMs: check.latencyMs,
            toolCount: check.toolCount,
            toolsDiffer: check.toolsDiffer === true,
            error: check.error,
            at: check.at,
          },
        }));
      } catch (err) {
        setChecks((current) => ({ ...current, [entry.name]: { status: "fail", error: errText(err) } }));
      }
    }

    async function checkAll() {
      const list = entries || [];
      if (list.length === 0 || testingAll) return;
      setTestingAll(true);
      setProgress({ done: 0, total: list.length });
      const queue = list.slice();
      const worker = async () => {
        for (;;) {
          const entry = queue.shift();
          if (entry === undefined) return;
          await checkOne(entry);
          setProgress((current) => ({ ...current, done: current.done + 1 }));
        }
      };
      await Promise.all(Array.from({ length: Math.min(CHECK_CONCURRENCY, list.length) }, worker));
      setTestingAll(false);
      await refresh(reveal);
    }

    function statusOf(entry) {
      const live = checks[entry.name];
      if (live !== undefined && live.status === "running") return { tone: "busy", label: "检测中\u2026" };
      if (live !== undefined && live.status === "ok") {
        return {
          tone: "ok",
          label: "连通 \u00b7 " + formatMs(live.latencyMs)
            + (typeof live.toolCount === "number" ? " \u00b7 " + live.toolCount + " 个工具" : ""),
        };
      }
      if (live !== undefined && live.status === "fail") return { tone: "fail", label: "连接失败" };
      const last = entry.lastCheck;
      if (last !== null && last !== undefined) {
        return last.ok
          ? { tone: "ok", label: "上次连通 \u00b7 " + formatMs(last.latencyMs) + " \u00b7 " + relativeTime(last.at) }
          : { tone: "fail", label: "上次失败 \u00b7 " + relativeTime(last.at) };
      }
      return { tone: "idle", label: "未检测" };
    }

    // The freshest failure is what a person needs to read; an old one only shows
    // when nothing newer has been asked for.
    function failureOf(entry) {
      const live = checks[entry.name];
      if (live !== undefined && live.status === "fail" && live.error) return String(live.error);
      const last = entry.lastCheck;
      if (live === undefined && last !== null && last !== undefined && last.ok === false && last.error) return String(last.error);
      return "";
    }

    // Plugin-contributed rows: toggled through the host's loader at runtime, so the
    // change lands immediately and survives until the next boot (the row's own
    // bundle patch is untouched).
    async function toggleNative(item, enabled) {
      setBusyNative("item:" + item.id);
      try {
        const data = await postJson("/skill-mcp-manager/mcp/native", { id: item.id, enabled });
        if (data.native) setNative(data.native);
        setNotice("已" + (enabled ? "启用 " : "停用 ") + item.serverName + "（即时生效，无需重启）");
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusyNative("");
      }
    }

    async function toggleNativeGroup(group, enabled) {
      setBusyNative(group.key);
      try {
        for (const item of group.items) {
          if (item.enabled === enabled) continue;
          const data = await postJson("/skill-mcp-manager/mcp/native", { id: item.id, enabled });
          if (data.native) setNative(data.native);
        }
        setNotice("已" + (enabled ? "启用 " : "停用 ") + (group.owner || "未归属插件") + " 的 "
          + group.items.length + " 个 MCP（即时生效，无需重启）");
      } catch (err) {
        setError(errText(err));
      } finally {
        setBusyNative("");
      }
    }

    function nativeCard(item) {
      return h("article", {
        key: "native-" + item.id,
        className: cx("smx-card", !item.enabled && "is-dimmed"),
      },
        h("div", { className: "smx-card__head" },
          h("span", { className: cx("smx-dot", item.enabled ? "smx-dot--ok" : "smx-dot--idle") }),
          h("div", { className: "smx-card__ident" },
            h("span", { className: "smx-card__name", title: item.id }, item.serverName),
            h("span", { className: "smx-card__sub" },
              [item.transport, item.urlHost || item.command].filter(Boolean).join(" \u00b7 ")),
          ),
          h(Badge, { tone: "muted" }, "插件"),
        ),
        h("p", { className: cx("smx-card__desc", "is-empty") },
          "由插件注入的 loader 行（" + item.id + "），不在能力库注册表里。"),
        h("div", { className: "smx-card__status" },
          h("span", null, item.enabled ? "已启用" : "已停用"),
          h("span", { className: "smx-card__hint" }, "开关即时生效，无需重启"),
        ),
        h("div", { className: "smx-card__foot" },
          h("label", { className: "smx-switchline" },
            h(Switch, {
              checked: item.enabled,
              disabled: busyNative === "item:" + item.id,
              onChange: (next) => toggleNative(item, next),
            }),
            h("span", { className: "smx-switchline__label" }, item.enabled ? "启用中" : "已停用"),
          ),
        ),
      );
    }

    function envRows(entry) {
      const keys = Object.keys(entry.env || {});
      if (keys.length === 0) return null;
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, "环境变量"),
        keys.map((k) => kv(k, entry.env[k])),
      );
    }

    function headerRows(entry) {
      const keys = Object.keys(entry.headers || {});
      if (keys.length === 0) return null;
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, "Headers"),
        keys.map((k) => kv(k, entry.headers[k])),
      );
    }

    function toolsSection(entry) {
      if (!entry.tools || entry.tools.length === 0) {
        return h("div", { className: "smx-detail__section" },
          h("div", { className: "smx-detail__label" }, "工具"),
          h(Empty, null, "无工具快照（请刷新快照）"),
        );
      }
      return h("div", { className: "smx-detail__section" },
        h("div", { className: "smx-detail__label" }, "工具 (" + entry.tools.length + ")"),
        h("ul", { className: "smx-tools" },
          entry.tools.map((tool) => h("li", {
            key: tool.name,
            className: cx("smx-tool", tool.enabled === false && "is-disabled"),
          },
            h("select", {
              className: cx("smx-tool__tier", tool.enabled === false && "is-disabled"),
              value: tool.enabled === false ? "disabled" : "enabled",
              "aria-label": tool.name + " 档位",
              onChange: (event) => setToolEnabled(entry, tool, event.target.value === "enabled"),
            },
              h("option", { value: "enabled" }, "启用"),
              h("option", { value: "disabled" }, "禁用"),
            ),
            h("span", { className: "smx-tool__name" }, tool.name),
            tool.description ? h("span", { className: "smx-tool__desc" }, tool.description) : null,
          )),
        ),
      );
    }

    function detailBlock(entry) {
      const last = entry.lastCheck;
      return h("div", { className: "smx-detail" },
        h("div", { className: "smx-detail__section" },
          h("div", { className: "smx-detail__label" }, "档位"),
          h("select", {
            className: "smx-select",
            value: entry.tier,
            onChange: (e) => setTier(entry, e.target.value),
          }, TIERS.map((t) => h("option", { key: t, value: t }, TIER_LABEL[t] + " (" + t + ")"))),
        ),
        kv("传输", entry.transport),
        last !== null && last !== undefined
          ? kv("上次检测", (last.ok ? "连通" : "失败") + " \u00b7 " + formatMs(last.latencyMs) + " \u00b7 " + relativeTime(last.at))
          : kv("上次检测", "未检测"),
        entry.serverDescription ? kv("描述", entry.serverDescription) : null,
        entry.serverName ? kv("服务器自报名", entry.serverName) : null,
        entry.serverVersion ? kv("版本", entry.serverVersion) : null,
        entry.serverTitle ? kv("标题", entry.serverTitle) : null,
        entry.websiteUrl ? kv("网站", entry.websiteUrl) : null,
        entry.command !== null && entry.command !== undefined ? kv("命令", entry.command) : null,
        (entry.args || []).length > 0 ? kv("参数", (entry.args || []).join(" ")) : null,
        entry.url ? kv("URL", entry.url) : null,
        entry.cwd ? kv("工作目录", entry.cwd) : null,
        entry.instructions ? kv("使用说明", entry.instructions) : null,
        entry.notes ? kv("备注", entry.notes) : null,
        entry.lastLoadAt ? kv("上次刷新快照", entry.lastLoadAt) : null,
        envRows(entry),
        headerRows(entry),
        toolsSection(entry),
        h("div", { className: "smx-detail__actions" },
          h("button", { type: "button", className: "smx-btn", onClick: () => checkOne(entry) }, "检测连接"),
          h("button", { type: "button", className: "smx-btn", onClick: () => run(entry, true) }, "查看描述"),
          h("button", { type: "button", className: "smx-btn", onClick: () => run(entry, false) }, "刷新快照"),
        ),
        output ? h("pre", { className: "smx-output" }, output) : null,
      );
    }

    const cards = (entries || []).map((entry) => {
      const state = statusOf(entry);
      const failure = failureOf(entry);
      const live = checks[entry.name];
      const running = live !== undefined && live.status === "running";
      const differs = (live !== undefined && live.toolsDiffer === true)
        || (live === undefined && entry.lastCheck !== null && entry.lastCheck !== undefined && entry.lastCheck.toolsDiffer === true);
      return h("article", { key: entry.name, className: "smx-card" },
        h("div", { className: "smx-card__head" },
          h("span", { className: cx("smx-dot", "smx-dot--" + state.tone), title: state.label }),
          h("div", { className: "smx-card__ident" },
            h("span", { className: "smx-card__name", title: entry.name }, entry.name),
            h("span", { className: "smx-card__sub" },
              (entry.transport || "?") + " \u00b7 " + entry.toolCount + " 个工具"),
          ),
          h("select", {
            className: "smx-select smx-select--tight",
            value: entry.tier,
            "aria-label": entry.name + " 档位",
            onChange: (e) => setTier(entry, e.target.value),
          }, TIERS.map((t) => h("option", { key: t, value: t }, TIER_LABEL[t]))),
        ),
        h("p", { className: cx("smx-card__desc", !entry.serverDescription && "is-empty") },
          entry.serverDescription ? entry.serverDescription : "服务器未提供描述"),
        h("div", { className: "smx-card__status" },
          h("span", null, state.label),
          entry.connectFailed ? h(Badge, { tone: "muted" }, "常驻启动失败") : null,
          differs ? h("span", { className: "smx-card__hint" }, "工具已变化，建议刷新快照") : null,
        ),
        failure ? h("div", { className: "smx-card__error", title: failure }, failure) : null,
        h("div", { className: "smx-card__foot" },
          h("div", { className: "smx-card__actions" },
            h("button", {
              type: "button",
              className: "smx-btn smx-btn--primary",
              disabled: running,
              onClick: () => checkOne(entry),
            }, running ? "检测中\u2026" : "检测"),
            h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => { setOutput(""); setDetail(entry.name); } }, "详情"),
          ),
          confirming === entry.name
            ? h("span", { className: "smx-confirm" },
                h("button", { type: "button", className: "smx-btn smx-btn--danger", onClick: () => remove(entry) }, "确认删除条目"),
                h("button", { type: "button", className: "smx-btn", onClick: () => setConfirming("") }, "取消"),
              )
            : h("button", { type: "button", className: "smx-btn smx-btn--ghost", onClick: () => setConfirming(entry.name) }, "删除"),
        ),
      );
    });

    // One outcome per server: the fresh answer wins over the recorded one, and a
    // running probe counts as neither — otherwise the header would claim a
    // result before the server has said anything.
    const outcomes = (entries || []).map((entry) => {
      const live = checks[entry.name];
      if (live !== undefined) {
        if (live.status === "ok") return "ok";
        if (live.status === "fail") return "fail";
        return "busy";
      }
      const last = entry.lastCheck;
      if (last === null || last === undefined) return "none";
      return last.ok === true ? "ok" : "fail";
    });
    const okCount = outcomes.filter((outcome) => outcome === "ok").length;
    const failCount = outcomes.filter((outcome) => outcome === "fail").length;
    const busyCount = outcomes.filter((outcome) => outcome === "busy").length;
    const opened = (entries || []).find((entry) => entry.name === detail);

    const nativeEntries = native.entries || [];
    const nativeGroups = [];
    {
      const byOwner = new Map();
      for (const item of nativeEntries) {
        const key = item.owner || "(未归属插件)";
        let group = byOwner.get(key);
        if (group === undefined) {
          group = { key, owner: item.owner, items: [] };
          byOwner.set(key, group);
          nativeGroups.push(group);
        }
        group.items.push(item);
      }
    }
    const nativeSections = nativeGroups.map((group) => {
      const unfolded = openGroups[group.key] === true;
      const enabledCount = group.items.filter((item) => item.enabled).length;
      return h("section", { key: "native-" + group.key, className: "smx-group smx-group--plugin" },
        h("div", { className: "smx-group__head" },
          h("button", {
            type: "button",
            className: "smx-group__toggle",
            "aria-expanded": unfolded ? "true" : "false",
            onClick: () => setOpenGroups((current) => ({ ...current, [group.key]: !unfolded })),
          },
            h("span", { className: cx("smx-group__chevron", unfolded && "is-open") }, "\u25b8"),
            h("span", { className: "smx-group__title" }, "插件 \u00b7 " + group.key),
            h("span", { className: "smx-group__count" }, group.items.length + " 个 \u00b7 启用 " + enabledCount),
          ),
          h("span", { className: "smx-group__switch" },
            h(Switch, {
              checked: enabledCount > 0,
              disabled: busyNative === group.key,
              onChange: (next) => toggleNativeGroup(group, next),
            }),
            h("span", { className: "smx-switchline__label" },
              enabledCount === 0
                ? "全部关闭"
                : enabledCount === group.items.length ? "全部开启" : "部分开启"),
          ),
        ),
        unfolded ? h("div", { className: "smx-cards" }, group.items.map(nativeCard)) : null,
      );
    });

    return h("div", { className: "smx" },
      h("div", { className: "smx-head" },
        h("span", { className: "smx-count" }, entries
          ? String(entries.length) + " 个服务器 \u00b7 连通 " + okCount + " \u00b7 失败 " + failCount
            + (busyCount > 0 ? " \u00b7 检测中 " + busyCount : "")
            + " \u00b7 未检测 " + outcomes.filter((outcome) => outcome === "none").length
            + (nativeEntries.length > 0 ? " \u00b7 插件 MCP " + nativeEntries.length : "")
          : ""),
        h("div", { className: "smx-head__meta" },
          h("button", {
            type: "button",
            className: "smx-btn smx-btn--primary",
            disabled: testingAll || !entries || entries.length === 0,
            onClick: checkAll,
          }, testingAll ? "检测中 " + progress.done + "/" + progress.total : "全部检测"),
          h("button", { type: "button", className: "smx-btn", onClick: toggleReveal }, reveal ? "隐藏密钥" : "显示密钥"),
          h("button", { type: "button", className: "smx-btn", onClick: () => refresh(reveal) }, "刷新"),
        ),
      ),
      h("div", { className: "smx-settings-card" },
        h("button", {
          type: "button",
          className: "smx-settings-card__toggle",
          onClick: () => setAdvanced(!advanced),
        },
          h("span", { className: "smx-settings-card__title" }, "高级设置"),
          h("span", { className: "smx-count" }, advanced ? "收起" : "展开"),
        ),
        advanced ? h("div", { className: "smx-settings-card__body" },
        h("div", { className: "smx-setting__row" },
          h("span", { className: "smx-setting__label" }, "工具描述截断（字符）"),
          h("input", {
            type: "number",
            className: "smx-input",
            value: toolDescDraft,
            min: 1,
            max: 5000,
            onChange: (e) => setToolDescDraft(e.target.value),
          }),
          h("button", { type: "button", className: "smx-btn", onClick: saveToolDesc }, "保存"),
          h("span", { className: "smx-count" }, "当前 " + toolDescMax),
        ),
        h("div", { className: "smx-setting__row" },
          h("span", { className: "smx-setting__label" }, "stdio 消息上限（MB）"),
          h("input", {
            type: "number",
            className: "smx-input",
            value: bufferDraft,
            min: 1,
            placeholder: "SDK 默认 10",
            onChange: (e) => setBufferDraft(e.target.value),
          }),
          h("button", { type: "button", className: "smx-btn", onClick: saveBufferMb }, "保存"),
          h("span", { className: "smx-count" },
            bufferMb === null ? "当前 SDK 默认 10 MB；超出上限的消息会被丢弃并报错，连接不断开" : "当前 " + bufferMb + " MB"),
        ),
        ) : null,
      ),
      notice ? h(Notice, { kind: "success", onDismiss: () => setNotice("") }, notice) : null,
      error ? h(Notice, { kind: "error", onDismiss: () => setError("") }, error) : null,
      loading ? h(Empty, null, "加载中\u2026")
        : (entries || []).length === 0 && nativeEntries.length === 0
          ? h(Empty, null, "没有已注册的 MCP 服务器")
          : h("div", { className: "smx-groups" },
              h("section", { className: "smx-group smx-group--system" },
                h("div", { className: "smx-group__head" },
                  h("div", { className: "smx-group__toggle" },
                    h("span", { className: "smx-group__title" }, "系统"),
                    h("span", { className: "smx-group__count" }, (entries || []).length + " 个"),
                  ),
                ),
                (entries || []).length === 0
                  ? h(Empty, null, "能力库里还没有 MCP 服务器")
                  : h("div", { className: "smx-cards" }, cards),
              ),
              nativeSections,
            ),
      opened
        ? h("div", { className: "smx-drawer", role: "dialog", "aria-label": opened.name + " 详情" },
            h("div", { className: "smx-drawer__scrim", onClick: () => { setDetail(""); setOutput(""); } }),
            h("div", { className: "smx-drawer__panel" },
              h("div", { className: "smx-drawer__head" },
                h("span", { className: "smx-drawer__title" }, opened.name),
                h(Badge, { tone: TIER_TONE[opened.tier] || "muted" }, TIER_LABEL[opened.tier] || opened.tier),
                h("button", { type: "button", className: "smx-btn", onClick: () => { setDetail(""); setOutput(""); } }, "关闭"),
              ),
              detailBlock(opened),
            ),
          )
        : null,
    );
  }

  // ── capability section (tabs: 技能 / MCP) ────────────────────────────────
  const APPROVAL_OPTIONS = [
    ["follow", "跟随当前对话的 DSH 权限"],
    ["always-ask", "每次都问"],
    ["always-allow", "始终放行"],
  ];

  function PluginSettings() {
    const [approval, setApproval] = useState("follow");
    const [hosts, setHosts] = useState("");
    const [notice, setNotice] = useState("");
    const [error, setError] = useState("");

    useEffect(() => {
      getJson("/skill-mcp-manager/settings")
        .then((data) => {
          if (typeof data.localCommandApproval === "string") setApproval(data.localCommandApproval);
          if (Array.isArray(data.lanHostAllowlist)) setHosts(data.lanHostAllowlist.join(", "));
        })
        .catch(() => {});
    }, []);

    async function save() {
      const lanHostAllowlist = hosts.split(/[\n,]/).map((item) => item.trim()).filter(Boolean);
      try {
        const data = await postJson("/skill-mcp-manager/settings", { localCommandApproval: approval, lanHostAllowlist });
        if (typeof data.localCommandApproval === "string") setApproval(data.localCommandApproval);
        setHosts(Array.isArray(data.lanHostAllowlist) ? data.lanHostAllowlist.join(", ") : "");
        setNotice("已保存");
        setError("");
      } catch (err) {
        setError(errText(err));
      }
    }

    return h("div", { className: "smx-setting smx-setting--block" },
      h("div", { className: "smx-setting__row" },
        h("label", { className: "smx-setting__label" }, "模型登记本地程序"),
        h("select", {
          className: "smx-select",
          value: approval,
          onChange: (event) => setApproval(event.target.value),
        }, APPROVAL_OPTIONS.map((option) => h("option", { key: option[0], value: option[0] }, option[1]))),
      ),
      h("div", { className: "smx-setting__row" },
        h("label", { className: "smx-setting__label" }, "局域网主机名"),
        h("input", {
          className: "smx-input smx-input--wide",
          value: hosts,
          placeholder: "默认空。只有用电脑名打开时才填写",
          onChange: (event) => setHosts(event.target.value),
        }),
      ),
      h("div", { className: "smx-setting__save" },
        error ? h("span", { className: "smx-count" }, error) : null,
        notice ? h("span", { className: "smx-count" }, notice) : null,
        h("button", { type: "button", className: "smx-btn", onClick: save }, "保存"),
      ),
    );
  }

  function ManagerSection() {
    // MCP is what people come here for (and what the sidebar page opens on); the
    // skill tab is one click away.
    const [tab, setTab] = useState("mcp");
    return h("div", { className: "smx" },
      h("header", { className: "smx-header" },
        h("h2", { className: "smx-title" }, "能力库 (Capability)"),
        h("div", { className: "smx-subtitle" }, "管理 Agent 的 Skill 与 MCP"),
      ),
      h(PluginSettings),
      h(LegacySessionBanner),
      // MCP first: it is the default view and the reason this page exists.
      h("div", { className: "smx-tabs" },
        h("button", { type: "button", className: cx("smx-tab", tab === "mcp" && "is-active"), onClick: () => setTab("mcp") }, "MCP"),
        h("button", { type: "button", className: cx("smx-tab", tab === "skills" && "is-active"), onClick: () => setTab("skills") }, "技能"),
      ),
      tab === "skills" ? h(SkillsPanel) : h(McpPanel),
    );
  }

  // ── sidebar page ─────────────────────────────────────────────────────────
  // The same manager, as a page of its own: the host's sidebar row selects the
  // `main` panel, so a click on 能力库 lands here instead of inside the settings
  // dialog. The content is ManagerSection unchanged — two renderings of one
  // component, not two implementations of one feature.
  function CapabilityPage() {
    return h("div", { className: "smx-page" },
      h("div", { className: "smx-page__body" }, h(ManagerSection)),
    );
  }

  // Two stacked cards: the sidebar's own rows are line icons at 16px, so this
  // borrows currentColor and the same optical weight rather than a colored logo.
  function CapabilityIcon(props) {
    const size = typeof props.size === "number" && props.size > 0 ? props.size : 16;
    return h("svg", {
      width: size,
      height: size,
      viewBox: "0 0 16 16",
      fill: "none",
      "aria-hidden": "true",
      "data-dsh-part": "capability-sidebar-icon",
    },
      h("rect", { x: 1.9, y: 2.4, width: 8.8, height: 6.2, rx: 1.5, stroke: "currentColor", strokeWidth: 1.25 }),
      h("rect", { x: 5.3, y: 7.4, width: 8.8, height: 6.2, rx: 1.5, stroke: "currentColor", strokeWidth: 1.25, fill: "var(--dsw-alias-bg-layer-1)" }),
    );
  }

  // ── CSS ──────────────────────────────────────────────────────────────────
  const CSS = [
    ".smx { display:flex; flex-direction:column; gap:12px; min-width:0; }",
    // Sidebar page: the host gives the panel the full main area and reserves a
    // top band for the frame; the body keeps a centered reading column and owns
    // its own scrolling.
    ".smx-page { display:flex; flex-direction:column; box-sizing:border-box; height:100%; min-height:0; padding-top:calc(28px + var(--dsh-frame-top-clearance,0px)); }",
    ".smx-page__body { display:flex; flex-direction:column; flex:1; min-height:0; overflow:auto; padding-bottom:28px; padding-left:max(max(16px,min(4vw,48px)),50% - 480px); padding-right:max(max(16px,min(4vw,48px)),50% - 480px); }",
    ".smx-head { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; }",
    ".smx-title { margin:0; font-size:15px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-head__meta { display:flex; align-items:center; gap:8px; flex-wrap:wrap; }",
    ".smx-setting { display:flex; align-items:center; gap:8px; padding:8px 10px; border:1px solid var(--dsw-alias-border-l1); border-radius:8px; background:var(--dsw-alias-bg-layer-1); }",
    ".smx-setting--block { flex-direction:column; align-items:stretch; gap:10px; }",
    ".smx-setting__row { display:flex; align-items:center; gap:8px; min-width:0; flex-wrap:wrap; }",
    ".smx-setting__save { display:flex; justify-content:flex-end; align-items:center; gap:8px; }",
    ".smx-setting__label { flex:none; white-space:nowrap; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-input { font-size:12px; padding:5px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); width:72px; }",
    ".smx-input--wide { width:auto; flex:1; min-width:0; }",
    ".smx-count { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-btn { font-size:12px; line-height:1; padding:6px 10px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); cursor:pointer; }",
    ".smx-btn:hover { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }",
    ".smx-btn:disabled { opacity:.55; cursor:default; }",
    ".smx-btn:disabled:hover { border-color:var(--dsw-alias-border-l2); color:var(--dsw-alias-label-primary); }",
    ".smx-btn--ghost { border-color:var(--dsw-alias-border-l1); color:var(--dsw-alias-label-secondary); }",
    ".smx-btn--danger { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }",
    ".smx-btn--primary { border-color:var(--dsw-alias-brand-primary); color:var(--dsw-alias-brand-primary); }",
    ".smx-cards { display:grid; grid-template-columns:repeat(auto-fill,minmax(240px,1fr)); gap:10px; align-items:stretch; }",
    // Groups: one header row per origin. The plugin groups start folded and own a
    // master switch; 系统 has neither, because it is the list itself.
    ".smx-groups { display:flex; flex-direction:column; gap:14px; }",
    ".smx-group { display:flex; flex-direction:column; gap:8px; min-width:0; }",
    ".smx-group__head { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:6px 8px; border:1px solid var(--dsw-alias-border-l1); border-radius:10px; background:var(--dsw-alias-bg-layer-2); }",
    ".smx-group--system > .smx-group__head { background:transparent; }",
    ".smx-group__toggle { display:flex; align-items:center; gap:8px; flex:1; min-width:0; padding:0; border:none; background:none; color:inherit; cursor:pointer; text-align:left; }",
    ".smx-group__chevron { display:inline-block; flex:none; font-size:10px; color:var(--dsw-alias-label-secondary); transition:transform .12s ease; }",
    ".smx-group__chevron.is-open { transform:rotate(90deg); }",
    ".smx-group__title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
    ".smx-group__count { flex:none; font-size:11px; color:var(--dsw-alias-label-secondary); }",
    ".smx-group__sub { font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
    ".smx-group__switch { display:flex; align-items:center; gap:6px; flex:none; }",
    ".smx-card { display:flex; flex-direction:column; gap:8px; min-width:0; padding:12px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); transition:border-color .12s ease, box-shadow .12s ease; }",
    ".smx-card:hover { border-color:var(--dsw-alias-border-l2); box-shadow:0 2px 12px rgba(0,0,0,.07); }",
    ".smx-card.is-readonly { border-style:dashed; }",
    ".smx-card.is-dimmed .smx-card__name { color:var(--dsw-alias-label-secondary); }",
    ".smx-card__head { display:flex; align-items:flex-start; gap:8px; min-width:0; }",
    ".smx-mark { flex:none; display:inline-flex; align-items:center; justify-content:center; width:26px; height:26px; border-radius:8px; font-size:10px; font-weight:700; letter-spacing:.02em; color:var(--dsw-alias-brand-primary); background:var(--dsw-alias-bg-layer-2); border:1px solid var(--dsw-alias-border-l1); }",
    ".smx-card__ident { display:flex; flex-direction:column; gap:2px; min-width:0; flex:1; }",
    ".smx-card__name { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
    ".smx-card__sub { font-size:11px; color:var(--dsw-alias-label-secondary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
    ".smx-card__desc { margin:0; font-size:12px; line-height:1.5; color:var(--dsw-alias-label-secondary); display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }",
    ".smx-card__desc.is-empty { font-style:italic; }",
    ".smx-card__status { display:flex; align-items:center; gap:6px; flex-wrap:wrap; font-size:11px; color:var(--dsw-alias-label-secondary); }",
    ".smx-card__hint { font-size:11px; color:var(--dsw-alias-label-secondary); }",
    ".smx-card__error { font-size:11px; line-height:1.45; color:var(--dsw-alias-state-error-primary); background:var(--dsw-alias-bg-layer-2); border-radius:6px; padding:6px 8px; max-height:76px; overflow:auto; word-break:break-word; }",
    ".smx-card__foot { display:flex; align-items:center; justify-content:space-between; gap:8px; flex-wrap:wrap; margin-top:auto; padding-top:8px; border-top:1px solid var(--dsw-alias-border-l1); }",
    ".smx-card__actions { display:flex; align-items:center; gap:6px; }",
    ".smx-dot { flex:none; width:8px; height:8px; margin-top:6px; border-radius:50%; background:var(--dsw-alias-border-l2); }",
    ".smx-dot--ok { background:var(--dsw-alias-state-success-primary); }",
    ".smx-dot--fail { background:var(--dsw-alias-state-error-primary); }",
    ".smx-dot--busy { background:var(--dsw-alias-brand-primary); animation:smx-pulse 1s ease-in-out infinite; }",
    "@keyframes smx-pulse { 0%,100% { opacity:1; } 50% { opacity:.3; } }",
    ".smx-settings-card { display:flex; flex-direction:column; gap:8px; padding:10px 12px; border:1px solid var(--dsw-alias-border-l1); border-radius:12px; background:var(--dsw-alias-bg-layer-1); }",
    ".smx-settings-card__title { font-size:12px; font-weight:600; color:var(--dsw-alias-label-secondary); }",
    ".smx-settings-card__toggle { display:flex; align-items:center; justify-content:space-between; gap:8px; width:100%; padding:0; border:none; background:none; cursor:pointer; }",
    ".smx-settings-card__body { display:flex; flex-direction:column; gap:8px; }",
    ".smx-drawer { position:fixed; inset:0; z-index:60; display:flex; justify-content:flex-end; }",
    ".smx-drawer__scrim { position:absolute; inset:0; background:rgba(0,0,0,.28); }",
    ".smx-drawer__panel { position:relative; display:flex; flex-direction:column; gap:10px; width:480px; max-width:92vw; height:100%; overflow:auto; padding:14px; background:var(--dsw-alias-bg-layer-1); border-left:1px solid var(--dsw-alias-border-l1); box-shadow:-8px 0 24px rgba(0,0,0,.16); }",
    ".smx-drawer__head { display:flex; align-items:center; gap:8px; }",
    ".smx-drawer__title { flex:1; font-size:14px; font-weight:600; color:var(--dsw-alias-label-primary); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }",
    ".smx-switchline { display:flex; align-items:center; gap:6px; }",
    ".smx-switchline__label { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-switch { position:relative; width:30px; height:17px; border-radius:999px; border:none; background:var(--dsw-alias-border-l2); cursor:pointer; padding:0; flex-shrink:0; }",
    ".smx-switch.is-on { background:var(--dsw-alias-brand-primary); }",
    ".smx-switch__knob { position:absolute; top:2px; left:2px; width:13px; height:13px; border-radius:50%; background:#fff; transition:left .12s ease; }",
    ".smx-switch.is-on .smx-switch__knob { left:15px; }",
    ".smx-badge { font-size:10px; padding:2px 6px; border-radius:999px; border:1px solid var(--dsw-alias-border-l2); color:var(--dsw-alias-label-secondary); white-space:nowrap; }",
    ".smx-badge--success { color:var(--dsw-alias-state-success-primary); border-color:var(--dsw-alias-state-success-primary); }",
    ".smx-badge--info { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-brand-primary); }",
    ".smx-badge--muted { color:var(--dsw-alias-label-secondary); border-color:var(--dsw-alias-border-l1); }",
    ".smx-notice { display:flex; align-items:center; justify-content:space-between; gap:8px; padding:8px 10px; border-radius:6px; font-size:12px; border:1px solid var(--dsw-alias-border-l1); background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); }",
    ".smx-notice--success { border-color:var(--dsw-alias-state-success-primary); }",
    ".smx-notice--error { border-color:var(--dsw-alias-state-error-primary); color:var(--dsw-alias-state-error-primary); }",
    ".smx-notice__close { border:none; background:none; color:inherit; cursor:pointer; font-size:14px; padding:0 2px; }",
    ".smx-legacy { display:flex; flex-direction:column; gap:4px; line-height:1.6; text-align:left; }",
    ".smx-legacy__title { font-weight:600; }",
    ".smx-legacy__code { font-family:var(--ds-font-family-code); font-size:11px; padding:1px 4px; border-radius:4px; background:var(--dsw-alias-bg-layer-2); }",
    ".smx-legacy__link { color:var(--dsw-alias-brand-primary); }",
    ".smx-legacy__note { color:var(--dsw-alias-label-secondary); }",
    ".smx-toast { position:absolute; right:16px; bottom:16px; display:flex; align-items:flex-start; gap:10px; max-width:360px; padding:10px 12px; border-radius:10px; border:1px solid var(--dsw-alias-state-error-primary); background:var(--dsw-alias-bg-layer-1); box-shadow:0 8px 28px rgba(0,0,0,.18); pointer-events:auto; }",
    ".smx-toast--checking { border-color:var(--dsw-alias-border-l2); }",
    ".smx-toast--ok { border-color:var(--dsw-alias-state-success-primary); }",
    ".smx-toast__main { min-width:0; }",
    ".smx-toast__title { font-size:13px; font-weight:600; color:var(--dsw-alias-label-primary); }",
    ".smx-toast__text { margin-top:4px; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-toast__close { border:none; background:none; color:var(--dsw-alias-label-secondary); cursor:pointer; font-size:15px; line-height:1; padding:0 2px; }",
    ".smx-empty { padding:18px; text-align:center; font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-confirm { display:inline-flex; gap:6px; align-items:center; }",
    ".smx-detail { display:flex; flex-direction:column; gap:8px; }",
    ".smx-detail__section { display:flex; flex-direction:column; gap:4px; }",
    ".smx-detail__label { font-size:11px; font-weight:600; color:var(--dsw-alias-label-secondary); }",
    ".smx-detail__actions { display:flex; gap:8px; flex-wrap:wrap; }",
    ".smx-kv { display:flex; gap:8px; font-size:12px; }",
    ".smx-kv__k { flex-shrink:0; color:var(--dsw-alias-label-secondary); }",
    ".smx-kv__v { color:var(--dsw-alias-label-primary); word-break:break-all; }",
    ".smx-select { font-size:12px; padding:5px 8px; border-radius:6px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }",
    ".smx-select--tight { flex:none; font-size:11px; padding:3px 6px; }",
    ".smx-tools { list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:4px; }",
    ".smx-tool { display:flex; align-items:flex-start; gap:8px; font-size:12px; }",
    ".smx-tool__tier { flex-shrink:0; min-width:58px; font-size:11px; padding:2px 4px; border-radius:5px; border:1px solid var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); color:var(--dsw-alias-label-primary); }",
    ".smx-tool__tier.is-disabled { color:var(--dsw-alias-label-secondary); }",
    ".smx-tool__name { font-family:ui-monospace,monospace; color:var(--dsw-alias-label-primary); flex-shrink:0; }",
    ".smx-tool__desc { color:var(--dsw-alias-label-secondary); }",
    ".smx-tool.is-disabled .smx-tool__name, .smx-tool.is-disabled .smx-tool__desc { color:var(--dsw-alias-label-secondary); }",
    ".smx-output { margin:0; padding:8px; border-radius:6px; background:var(--dsw-alias-bg-layer-2); color:var(--dsw-alias-label-primary); font-size:11px; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; }",
    ".smx-header { display:flex; flex-direction:column; gap:2px; }",
    ".smx-subtitle { font-size:12px; color:var(--dsw-alias-label-secondary); }",
    ".smx-tabs { display:flex; gap:4px; border-bottom:1px solid var(--dsw-alias-border-l1); padding-bottom:8px; }",
    ".smx-tab { font-size:12px; padding:6px 12px; border-radius:6px; border:1px solid transparent; background:none; color:var(--dsw-alias-label-secondary); cursor:pointer; }",
    ".smx-tab.is-active { color:var(--dsw-alias-brand-primary); border-color:var(--dsw-alias-border-l2); background:var(--dsw-alias-bg-layer-1); }",
  ].join("\n");

  function injectCss() {
    if (typeof document === "undefined") return;
    const tagId = "@deepseek-ai/dsh-skill-mcp-manager";
    if (document.querySelector("style[data-plugin-css=" + JSON.stringify(tagId) + "]") !== null) return;
    const tag = document.createElement("style");
    tag.dataset.plugin = "dsh-skill-mcp-manager";
    tag.dataset.pluginCss = tagId;
    tag.textContent = CSS;
    document.head.appendChild(tag);
  }

  // ── apply ────────────────────────────────────────────────────────────────
  function apply(ctx) {
    injectCss();
    ctx.slots.inject("settings.section", () => ctx.slots.register({
      name: "settings.section",
      id: "capability",
      order: 35,
      label: "能力库",
    }, ManagerSection));
    // Frame-wide notices belong in the shell overlay, not in a settings page:
    // `shell.overlay` is a root-scope `list` slot rendered with no props inside
    // the frame's pointer-events:none layer, so the occupant positions itself
    // and everything around it stays click-through.
    ctx.slots.inject("shell.overlay", () => ctx.slots.register({
      name: "shell.overlay",
      id: "capability-legacy-sessions",
      order: 80,
    }, LegacySessionOverlay));

    // Sidebar page: a row in the host's panel list plus the `main` panel it
    // selects. Both seats are the host's own and are declared lazily — a host
    // that predates them simply never injects, and the settings section above
    // stays the only entry. Register the row last and undo the panel if it is
    // refused, so a half-registered page (a panel nothing can select) cannot
    // outlive the failure.
    let layout = null;
    ctx.inject(["layout"], (scoped) => {
      layout = scoped.layout;
    });
    ctx.slots.inject("main", () => ctx.slots.inject("sidebar.panellist", () => {
      const stopMain = ctx.slots.register({
        name: "main",
        key: PANEL_ID,
      }, () => h(CapabilityPage));
      let stopRow;
      try {
        stopRow = ctx.slots.register({
          name: "sidebar.panellist",
          id: PANEL_ID,
          order: 5,
          label: "能力库",
        }, (owner) => h(CapabilityIcon, { size: owner && owner.size }));
      } catch (error) {
        if (typeof stopMain === "function") stopMain();
        throw error;
      }
      return () => {
        // A panel the host still has selected after it disappears would render
        // an empty main area; leave the page first.
        try {
          if (layout !== null && layout.panelInfo.getSnapshot().activePanelId === PANEL_ID) layout.selectPanel(null);
        } catch {
          /* layout service already gone */
        }
        if (typeof stopRow === "function") stopRow();
        if (typeof stopMain === "function") stopMain();
      };
    }));
  }

  return { name, inject, apply };
}});

/**
 * Task-memory panel — browser half.
 *
 * Registered by the module loader through `dsh.client` in `package.json`; the factory below runs in
 * the Harness page and contributes two slots:
 *
 *   - `sidebar.panellist` — the sidebar entry that selects the panel;
 *   - `main` (same key)   — the panel body, which the layout renders as the centre column.
 *
 * Data comes from this plugin's own `/api/task-memory/*` routes through `fetch`, which works both in
 * the browser and in the Electron shell (its renderer proxies the same paths).
 *
 * Styling rule: only `--dsw-alias-*` theme tokens. Literal colours would not follow the host's
 * light/dark switching, and a panel that stays light in a dark shell looks broken.
 *
 * @module dsh-task-memory/client
 */

window.__ModuleLoader__.load({
  id: 'dsh-task-memory',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    const PANEL_ID = 'task-memory';

    /** Style tag id, so repeated materialization cannot stack duplicate sheets. */
    const CSS_ID = 'dsh-task-memory/panel.css';

    const CSS = `
/* Two-column shell: a fixed-width list on the left, the detail pane on the right.
 * The detail used to sit below the list, which meant scrolling past every card to read one — the
 * worse the memory grew, the further away it was. Splitting the columns keeps both in view. */
.tm-root{height:100%;display:flex;flex-direction:column;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px;overflow:hidden}
.tm-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;padding:20px 24px 0;flex:none}
.tm-titles{flex:1;min-width:240px}
.tm-h1{font-size:20px;font-weight:600;line-height:28px;margin:0}
.tm-sub{color:var(--dsw-alias-label-secondary);margin-top:4px;font-size:13px;line-height:20px;word-break:break-all}
.tm-actions{display:flex;gap:8px;flex-wrap:wrap}
.tm-btn{border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-button-elevated-fill);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-sm);padding:6px 12px;font:inherit;font-size:13px;cursor:pointer;height:32px;display:inline-flex;align-items:center;gap:6px}
.tm-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tm-btn:disabled{opacity:.5;cursor:default}
.tm-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.tm-btn-primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}
.tm-btn-primary:hover{background:var(--dsw-alias-button-primary-hover)}
.tm-btn-danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l3)}
.tm-toolbar{display:flex;gap:8px;align-items:center;margin:16px 0 0;padding:0 24px;flex:none;flex-wrap:wrap}
.tm-input,.tm-textarea{box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md);padding:6px 10px;font:inherit;font-size:13px}
.tm-input{min-width:200px;flex:1;height:32px}
.tm-input:focus,.tm-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.tm-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.tm-textarea{width:100%;min-height:280px;font-family:var(--ds-font-family-code);font-size:13px;line-height:20px;resize:vertical}
/* Custom dropdown.
 * A native <select> cannot be themed: its popup list is drawn by Chromium/OS and no CSS reaches
 * it, so it stayed white-on-dark while everything around it followed the theme. This reimplements
 * the control with the host's own menu recipe (translucent fill + backdrop blur + elevation
 * stroke/shadow, as in the host's Menu.module.css) so the popup reads as part of the same app. */
.tm-dd{position:relative;display:inline-flex;min-width:0}
.tm-dd-trigger{box-sizing:border-box;display:inline-flex;align-items:center;gap:8px;height:32px;max-width:100%;padding:0 10px;border:0.5px solid var(--dsw-alias-border-l4);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;cursor:pointer;text-align:left}
.tm-dd-trigger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}
.tm-dd-trigger:disabled{opacity:.5;cursor:default}
.tm-dd-trigger:focus-visible{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.tm-dd-open{border-color:var(--dsw-alias-state-business-primary)}
.tm-dd-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.tm-dd-chevron{flex:none;width:12px;height:12px;color:var(--dsw-alias-label-tertiary)}
.tm-dd-menu{position:absolute;top:calc(100% + 4px);left:0;z-index:100;box-sizing:border-box;min-width:100%;max-width:min(420px,80vw);max-height:320px;overflow-y:auto;padding:4px;display:flex;flex-direction:column;gap:0;border-radius:var(--dsw-radius-md);background:var(--dsw-menu-surface-fill);backdrop-filter:var(--dsw-menu-backdrop-filter);-webkit-backdrop-filter:var(--dsw-menu-backdrop-filter);box-shadow:var(--dsw-elevation-prominent);--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2);--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2)}
/* Without backdrop blur the translucent fill would composite against arbitrary page content.
   Fall back to the opaque layer-1 surface so the list is always legible. */
@supports not ((backdrop-filter:blur(1px)) or (-webkit-backdrop-filter:blur(1px))){
.tm-dd-menu{background:var(--dsw-alias-bg-layer-1)}
}
.tm-dd-item{box-sizing:border-box;display:flex;align-items:center;gap:8px;width:100%;min-height:34px;padding:6px 8px;border:none;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:13px;line-height:20px;text-align:left;cursor:pointer;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.tm-dd-item:hover,.tm-dd-item-active{background:var(--dsw-alias-interactive-bg-hover)}
.tm-dd-item:focus-visible{outline:none}
.tm-dd-check{flex:none;width:14px;height:14px;color:var(--dsw-alias-label-primary)}
.tm-dd-text{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.tm-dd-empty{padding:6px 8px;font-size:12px;color:var(--dsw-alias-label-tertiary)}
.tm-notice{margin:12px 24px 0;padding:10px 12px;border-radius:8px;font-size:13px;line-height:20px;flex:none}
.tm-notice-err{color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary)}
.tm-notice-ok{color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3)}
/* The columns. */
.tm-columns{flex:1;min-height:0;display:flex;gap:0;margin-top:16px;border-top:0.5px solid var(--dsw-alias-border-l2)}
.tm-list-col{flex:none;width:320px;min-width:0;display:flex;flex-direction:column;border-right:0.5px solid var(--dsw-alias-border-l2);overflow-y:auto;padding:12px}
.tm-detail-col{flex:1;min-width:0;overflow-y:auto;padding:20px 24px 48px}
.tm-detail-empty{height:100%;display:flex;align-items:center;justify-content:center;color:var(--dsw-alias-label-tertiary);font-size:13px;text-align:center;line-height:22px;padding:24px}
.tm-list{display:flex;flex-direction:column;gap:6px}
.tm-card{border:0.5px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:10px 12px;background:var(--dsw-alias-bg-base);cursor:pointer}
.tm-card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tm-card-active{border-color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.tm-card-top{display:flex;align-items:center;gap:6px;flex-wrap:wrap}
.tm-name{font-family:var(--ds-font-family-code);font-size:12px;font-weight:600;word-break:break-all}
.tm-desc{margin-top:4px;line-height:18px;font-size:13px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
.tm-meta{margin-top:6px;font-size:11px;color:var(--dsw-alias-label-secondary);display:flex;gap:8px;flex-wrap:wrap}
.tm-tag{display:inline-block;border-radius:6px;padding:1px 5px;font-size:11px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);margin-right:4px}
.tm-badges{display:flex;gap:4px;flex-wrap:wrap;margin-top:4px}
.tm-badge{font-size:11px;border-radius:6px;padding:1px 6px;line-height:16px}
.tm-badge-ok{color:var(--dsw-alias-label-secondary);background:var(--dsw-alias-interactive-bg-hover)}
.tm-badge-warn{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-interactive-bg-hover)}
.tm-badge-pub{color:var(--dsw-alias-state-business-primary);background:var(--dsw-alias-interactive-bg-hover)}
.tm-check{display:flex;align-items:center;gap:8px;font-size:13px;cursor:pointer}
.tm-check input{width:14px;height:14px;margin:0;accent-color:var(--dsw-alias-state-business-primary);cursor:pointer}
.tm-hint{color:var(--dsw-alias-label-tertiary);font-size:12px}
.tm-empty{padding:32px 8px;color:var(--dsw-alias-label-secondary);text-align:center;line-height:22px;font-size:13px}
.tm-field{margin-bottom:12px}
.tm-label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.tm-detail-head{display:flex;align-items:flex-start;gap:12px;flex-wrap:wrap;margin-bottom:16px}
.tm-detail-title{font-family:var(--ds-font-family-code);font-size:16px;font-weight:600;margin:0;word-break:break-all;flex:1;min-width:200px}
.tm-row{display:flex;gap:8px;flex-wrap:wrap}
.tm-row>*{flex:1;min-width:180px}
.tm-icon{width:18px;height:18px;display:block}
/* Date range and the "which days hold cards" strip.
 * A native date input's calendar popup is drawn by Chromium, so it cannot be themed — the same
 * limitation as <select>. The information a calendar would carry is therefore surfaced beside the
 * input as a row of clickable day chips. */
.tm-range{gap:8px;flex-wrap:wrap}
.tm-range-label{font-size:12px;color:var(--dsw-alias-label-secondary)}
.tm-date{min-width:0;width:auto;flex:0 0 auto;height:32px;padding:4px 8px}
.tm-range-hint{font-size:12px;color:var(--dsw-alias-label-tertiary)}
.tm-days{display:flex;gap:4px;flex-wrap:wrap;padding:0 24px;margin-top:8px;flex:none;max-height:76px;overflow-y:auto}
.tm-day{display:inline-flex;align-items:baseline;gap:4px;border:0.5px solid var(--dsw-alias-border-l3);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);border-radius:var(--dsw-radius-sm);padding:2px 6px;font:inherit;font-size:11px;cursor:pointer}
.tm-day:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tm-day-active{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-label-primary)}
.tm-day-count{color:var(--dsw-alias-state-business-primary);font-weight:600}
/* Recency group heading inside the list. */
.tm-group{display:flex;align-items:baseline;gap:6px;padding:10px 2px 2px;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.tm-group:first-child{padding-top:2px}
.tm-group-name{font-weight:600}
.tm-group-count{opacity:.8}
/* Settings section: a plain form on the settings page's own surface. */
.tm-settings{overflow-y:auto;padding:24px 28px 48px}
.tm-settings-body{max-width:640px;margin-top:8px}
.tm-h2{font-size:14px;font-weight:600;margin:20px 0 4px}
.tm-num{flex:1;min-width:120px}
.tm-checks{display:flex;gap:16px;flex-wrap:wrap;margin-top:6px}
.tm-settings-actions{margin-top:24px;align-items:center}
`;

    /**
     * Inject the panel stylesheet once.
     * @returns a disposer removing the tag.
     */
    function installStyles() {
      const existing = document.querySelector(`style[data-plugin-css=${JSON.stringify(CSS_ID)}]`);
      if (existing !== null) return () => {};
      const tag = document.createElement('style');
      tag.dataset.plugin = 'dsh-task-memory';
      tag.dataset.pluginCss = CSS_ID;
      tag.textContent = CSS;
      document.head.appendChild(tag);
      return () => {
        tag.remove();
      };
    }

    /**
     * Call one panel route.
     * @param path - route path.
     * @param options - query parameters or a POST body.
     * @returns the parsed payload.
     * @throws {Error} with the host-reported reason.
     */
    async function call(path, options = {}) {
      const url = new URL(path, window.location.origin);
      for (const [key, value] of Object.entries(options.query ?? {})) {
        if (value !== undefined && value !== null && value !== '') url.searchParams.set(key, String(value));
      }
      const init = { method: options.body === undefined ? 'GET' : 'POST', headers: {} };
      if (options.body !== undefined) {
        init.headers['content-type'] = 'application/json';
        init.body = JSON.stringify(options.body);
      }
      const response = await fetch(url, init);
      let payload;
      try {
        payload = await response.json();
      } catch {
        throw new Error(`接口返回了非 JSON 响应（HTTP ${response.status}）`);
      }
      if (!response.ok || payload.ok !== true) {
        throw new Error(payload?.error ?? `请求失败（HTTP ${response.status}）`);
      }
      return payload;
    }

    /**
     * Chinese labels for the card lifecycle states.
     *
     * The stored values stay the English identifiers the tool schema and frontmatter use; only what
     * the panel *shows* is translated, so a card stays readable by the model while the UI stays
     * readable by the user.
     */
    const STATUS_LABELS = { verified: '已确认', draft: '草稿', stale: '可能过时' };

    /**
     * Render a card status for display.
     * @param status - stored status identifier.
     * @returns the Chinese label, falling back to the raw value.
     */
    function statusLabel(status) {
      return STATUS_LABELS[status] ?? status;
    }

    /** Chinese labels for the recency tiers, mirroring the host's own table. */
    const TIER_LABELS = { recent: '近期', past: '之前', old: '很久之前', ancient: '远古', forgotten: '遗忘' };

    /**
     * Render a recency tier for display.
     * @param tier - tier identifier.
     * @returns the Chinese label, falling back to the raw value.
     */
    function statusTierLabel(tier) {
      return TIER_LABELS[tier] ?? tier;
    }

    /**
     * Accessible dropdown that follows the host theme.
     *
     * Replaces a native `<select>`, whose popup list is drawn by Chromium/OS and cannot be styled —
     * it stayed white-on-dark in a dark shell. This keeps the behaviour users rely on from the
     * native control: a real button trigger, arrow-key navigation, Enter/Space to choose, Escape to
     * close, focus returning to the trigger, and a click outside closing the list.
     *
     * @param props - options, current value, change handler, and disabled flag.
     * @returns the dropdown element.
     */
    function Dropdown({ value, options, onChange, disabled = false, ariaLabel }) {
      const [open, setOpen] = React.useState(false);
      const [active, setActive] = React.useState(0);
      const rootRef = React.useRef(null);
      const triggerRef = React.useRef(null);

      const selected = options.find((option) => option.value === value);

      // Close on an outside pointer press. `pointerdown` rather than `click` so dragging out of the
      // list does not leave it open behind the next interaction.
      React.useEffect(() => {
        if (!open) return undefined;
        const onPointerDown = (event) => {
          if (rootRef.current !== null && !rootRef.current.contains(event.target)) setOpen(false);
        };
        document.addEventListener('pointerdown', onPointerDown, true);
        return () => document.removeEventListener('pointerdown', onPointerDown, true);
      }, [open]);

      // Seed the keyboard cursor on the current value whenever the list opens.
      React.useEffect(() => {
        if (!open) return;
        const index = options.findIndex((option) => option.value === value);
        setActive(index === -1 ? 0 : index);
      }, [open, options, value]);

      const choose = (next) => {
        setOpen(false);
        triggerRef.current?.focus();
        if (next !== value) onChange(next);
      };

      const onKeyDown = (event) => {
        if (disabled) return;
        if (event.key === 'Escape') {
          if (open) {
            event.preventDefault();
            setOpen(false);
          }
          return;
        }
        if (!open && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          setOpen(true);
          return;
        }
        if (!open) return;
        if (event.key === 'ArrowDown') {
          event.preventDefault();
          setActive((current) => (current + 1) % Math.max(options.length, 1));
        } else if (event.key === 'ArrowUp') {
          event.preventDefault();
          setActive((current) => (current - 1 + options.length) % Math.max(options.length, 1));
        } else if (event.key === 'Home') {
          event.preventDefault();
          setActive(0);
        } else if (event.key === 'End') {
          event.preventDefault();
          setActive(Math.max(options.length - 1, 0));
        } else if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          const option = options[active];
          if (option !== undefined) choose(option.value);
        } else if (event.key === 'Tab') {
          setOpen(false);
        }
      };

      const menu = !open ? null : h('div', { className: 'tm-dd-menu', role: 'listbox' },
        options.length === 0
          ? h('div', { className: 'tm-dd-empty' }, '没有可选项')
          : options.map((option, index) => h('button', {
            key: option.value,
            type: 'button',
            role: 'option',
            'aria-selected': option.value === value,
            className: `tm-dd-item${index === active ? ' tm-dd-item-active' : ''}`,
            onMouseEnter: () => setActive(index),
            onClick: () => choose(option.value),
          },
            h('span', { className: 'tm-dd-check', 'aria-hidden': true },
              option.value === value
                ? h('svg', { width: 14, height: 14, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 2.4, strokeLinecap: 'round', strokeLinejoin: 'round' }, h('path', { d: 'M4 12.5 9 17.5 20 6.5' }))
                : null),
            h('span', { className: 'tm-dd-text' }, option.label))));

      return h('div', { className: 'tm-dd', ref: rootRef },
        h('button', {
          type: 'button',
          ref: triggerRef,
          className: `tm-dd-trigger${open ? ' tm-dd-open' : ''}`,
          disabled,
          'aria-haspopup': 'listbox',
          'aria-expanded': open,
          'aria-label': ariaLabel,
          onClick: () => {
            if (disabled) return;
            setOpen((current) => !current);
          },
          onKeyDown,
        },
          h('span', { className: 'tm-dd-label' }, selected === undefined ? '请选择' : selected.label),
          h('svg', {
            className: 'tm-dd-chevron', viewBox: '0 0 12 12', fill: 'none', stroke: 'currentColor',
            strokeWidth: 1.5, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
          }, h('path', { d: 'M3 4.5 6 7.5 9 4.5' }))),
        menu);
    }

    /**
     * The settings page section.
     *
     * The host's automatic config forms only render fields a plugin declares through a schemastery
     * `Config` with `.volatile()` markers. This plugin deliberately has no schema — it is a plain JS
     * package installed by link, with no build step — so it ships its own section and reads/writes
     * the same configuration through its own routes. One source of truth either way: the values the
     * loader passes to `apply`.
     *
     * @returns the section element.
     */
    function SettingsSection() {
      const [settings, setSettings] = React.useState(null);
      const [configPath, setConfigPath] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);

      const fail = (error) => setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) });

      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const payload = await call('/api/task-memory/settings');
            // The host returns `effective` — every parameter with its value, defaults included — and
            // fills any missing one into the local file on the way, so this one response is also what
            // makes the file a complete description of the configuration.
            if (!cancelled) {
              setSettings(payload.effective ?? payload.settings);
              setConfigPath(payload.configPath ?? '');
            }
          } catch (error) {
            if (!cancelled) fail(error);
          }
        })();
        return () => {
          cancelled = true;
        };
      }, []);

      const save = async (patch) => {
        setBusy(true);
        try {
          const payload = await call('/api/task-memory/settings', { body: patch });
          setSettings(payload.effective ?? payload.settings);
          setConfigPath(payload.configPath ?? '');
          setNotice({ kind: 'ok', text: payload.message ?? '已保存。' });
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
        }
      };

      if (settings === null) {
        return h('div', { className: 'tm-root tm-settings' },
          h('div', { className: 'tm-empty' }, notice === null ? '读取中…' : notice.text));
      }

      /**
       * One number input bound to a nested or top-level settings field.
       *
       * @param path - `[key]` for a top-level field, `['tierDays', 'past']` for a nested one.
       * @param label - field label.
       * @param hint - explanatory line under the field.
       * @returns the field element.
       */
      const numberField = (path, label, hint) => {
        const [key, sub] = path;
        const value = sub === undefined ? settings[key] : settings[key]?.[sub];
        return h('div', { className: 'tm-field' },
          h('label', { className: 'tm-label' }, label),
          h('input', {
            className: 'tm-input tm-num',
            type: 'number',
            min: 1,
            value: value ?? '',
            disabled: busy,
            onChange: (event) => {
              const next = Number(event.target.value);
              setSettings(sub === undefined
                ? { ...settings, [key]: next }
                : { ...settings, [key]: { ...(settings[key] ?? {}), [sub]: next } });
            },
          }),
          h('div', { className: 'tm-hint' }, hint));
      };

      return h('div', { className: 'tm-root tm-settings' },
        h('div', { className: 'tm-head' },
          h('div', { className: 'tm-titles' },
            h('h1', { className: 'tm-h1' }, '任务记忆'),
            h('div', { className: 'tm-sub' }, '这些设置写入 profile 的插件配置，重启 Harness 后生效。'))),
        notice === null ? null : h('div', {
          className: `tm-notice ${notice.kind === 'err' ? 'tm-notice-err' : 'tm-notice-ok'}`,
        }, notice.text),
        h('div', { className: 'tm-settings-body' },
          h('h2', { className: 'tm-h2' }, '面板默认显示哪些档位'),
          h('div', { className: 'tm-hint' }, '打开记忆面板时默认勾选的档位。默认只看「近期」，避免旧卡淹没新结论。'),
          h('div', { className: 'tm-checks' },
            ['recent', 'past', 'old', 'ancient', 'forgotten'].map((tier) => h('label', { key: tier, className: 'tm-check' },
              h('input', {
                type: 'checkbox',
                checked: (settings.defaultTiers ?? []).includes(tier),
                disabled: busy,
                onChange: (event) => {
                  const current = new Set(settings.defaultTiers ?? []);
                  if (event.target.checked) current.add(tier);
                  else current.delete(tier);
                  setSettings({ ...settings, defaultTiers: [...current] });
                },
              }),
              h('span', {}, statusTierLabel(tier))))),

          h('h2', { className: 'tm-h2' }, '档位边界（天）'),
          h('div', { className: 'tm-hint' }, '必须递增，否则某一档永远无法到达。'),
          h('div', { className: 'tm-row' },
            numberField(['tierDays', 'past'], '近期 → 之前', '超过这个天数进入「之前」'),
            numberField(['tierDays', 'old'], '之前 → 很久之前', ''),
            numberField(['tierDays', 'ancient'], '很久之前 → 远古', ''),
            numberField(['tierDays', 'forgotten'], '远古 → 遗忘', '超过这里就只计数、不再列出')),

          h('h2', { className: 'tm-h2' }, '索引与正文'),
          h('div', { className: 'tm-row' },
            numberField(['maxCatalogCards'], '注入索引的卡片上限', '索引里最多列多少张卡'),
            numberField(['maxBodyChars'], '单张卡正文上限', '超出会截断并给出文件路径')),

          h('h2', { className: 'tm-h2' }, '自动落卡'),
          h('label', { className: 'tm-check' },
            h('input', {
              type: 'checkbox',
              checked: settings.autoCapture !== false,
              disabled: busy,
              onChange: (event) => setSettings({ ...settings, autoCapture: event.target.checked }),
            }),
            h('span', {}, '回合结束时自动追问是否落卡'),
            h('span', { className: 'tm-hint' }, '关掉后只能由你明确要求才记录')),

          h('div', { className: 'tm-actions tm-settings-actions' },
            h('button', {
              className: 'tm-btn tm-btn-primary',
              disabled: busy,
              onClick: () => void save({
                defaultTiers: settings.defaultTiers,
                tierDays: settings.tierDays,
                maxCatalogCards: settings.maxCatalogCards,
                maxBodyChars: settings.maxBodyChars,
                autoCapture: settings.autoCapture,
                includeSystemPrompt: settings.includeSystemPrompt,
              }),
            }, '保存'),
            h('button', {
              className: 'tm-btn',
              disabled: busy,
              onClick: () => void save({ reset: true }),
            }, '恢复默认'),
            h('span', { className: 'tm-hint' }, configPath === '' ? '' : `设置文件：${configPath}`)),
        ));    }

    /**
     * The sidebar entry: a book glyph.
     * @param props - slot props (size and active state).
     * @returns the icon element.
     */
    function PanelIcon({ size = 18 }) {
      return h('svg', {
        className: 'tm-icon', width: size, height: size, viewBox: '0 0 24 24',
        fill: 'none', stroke: 'currentColor', strokeWidth: 1.8,
        strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true,
      },
        h('path', { d: 'M4 5.5A1.5 1.5 0 0 1 5.5 4H10a2 2 0 0 1 2 2v13a1.6 1.6 0 0 0-1.6-1.5H5.5A1.5 1.5 0 0 1 4 16V5.5Z' }),
        h('path', { d: 'M20 5.5A1.5 1.5 0 0 0 18.5 4H14a2 2 0 0 0-2 2v13a1.6 1.6 0 0 1 1.6-1.5h4.9A1.5 1.5 0 0 0 20 16V5.5Z' }));
    }

    /**
     * The panel body: browse, read, create, edit, and delete this workspace's cards.
     * @returns the panel element.
     */
    function Panel() {
      const [workspaces, setWorkspaces] = React.useState([]);
      const [workspace, setWorkspace] = React.useState('');
      const [cards, setCards] = React.useState([]);
      /**
       * How many cards the workspace holds, before any filter.
       *
       * The empty state needs both numbers: "no cards at all" and "nothing matched this filter" call
       * for different advice, and with a tier filter switching the dates around, the second case is
       * now easy to reach — showing "还没有卡片" there would tell the user their memory is empty.
       */
      const [total, setTotal] = React.useState(0);
      const [selected, setSelected] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [loading, setLoading] = React.useState(true);
      // Tier filter: a set of selected tiers. Seeded from the host's configured default so the
      // panel opens showing what the deployment decided is worth seeing first.
      const [tiers, setTiers] = React.useState(null);
      /**
       * The tier filter, expressed as one choice.
       *
       * A set of toggles would be more expressive, but the common cases are "the default" and "give
       * me everything, including the old stuff", and a single dropdown states those unambiguously
       * without asking the reader to reason about a combination of checkboxes.
       */
      const [filterMode, setFilterMode] = React.useState('default');
      // Date range. Empty means "not restricted"; the pickers seed from the window their filter mode
      // covers, so the control reflects what the list is actually showing.
      const [from, setFrom] = React.useState('');
      const [to, setTo] = React.useState('');
      const [bounds, setBounds] = React.useState({ from: '', to: '' });
      /**
       * The date window each filter mode covers, supplied by the host.
       *
       * The tier boundaries are configuration, so the browser must not re-derive them — it would
       * drift the moment the ladder changes. Empty until the first response arrives.
       */
      const [modeRanges, setModeRanges] = React.useState({});
      const [days, setDays] = React.useState([]);

      const fail = (error) => setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
      const done = (text) => setNotice({ kind: 'ok', text });

      /**
       * The tier filter choices.
       *
       * `default` defers to the deployment's configured default (normally the recent tier alone), so
       * the panel's opening view is a policy, not a hard-coded guess.
       */
      const filterModes = [
        { value: 'default', label: '默认（近期）' },
        { value: 'all', label: '全部档位' },
        { value: 'recent', label: '仅近期' },
        { value: 'past', label: '仅之前' },
        { value: 'old', label: '仅很久之前' },
        { value: 'ancient', label: '仅远古' },
        { value: 'forgotten', label: '仅遗忘' },
      ];

      /** Which tiers a mode selects; `default` resolves through state seeded by the host. */
      const tiersForMode = (mode) => {
        if (mode === 'all') return ['recent', 'past', 'old', 'ancient', 'forgotten'];
        if (mode === 'default') return tiers === null ? [] : [...tiers];
        return [mode];
      };

      /**
       * Switch the tier filter, and move the date range onto the window that filter covers.
       *
       * Without this the two controls quietly disagree: picking 仅之前 while the range still spans
       * every date shows nothing, because the tier filter and the range are applied together. The
       * window comes from the host, which owns the tier boundaries.
       *
       * A range the user set by hand is deliberately replaced here — that is the point of choosing a
       * tier. "全时段" is the button that widens the range back.
       *
       * @param mode - the filter mode to switch to.
       */
      const chooseMode = (mode) => {
        setFilterMode(mode);
        const window = modeRanges[mode];
        if (window === undefined) return;
        setFrom(window.from);
        setTo(window.to);
      };

      React.useEffect(() => {
        let cancelled = false;
        (async () => {
          try {
            const payload = await call('/api/task-memory/workspaces');
            if (cancelled) return;
            const rows = Array.isArray(payload.workspaces) ? payload.workspaces : [];
            setWorkspaces(rows);
            if (rows.length > 0) setWorkspace((current) => current || rows[0].path);
            else setLoading(false);
          } catch (error) {
            if (!cancelled) {
              fail(error);
              setLoading(false);
            }
          }
        })();
        return () => {
          cancelled = true;
        };
      }, []);

      const reload = React.useCallback(async () => {
        if (workspace === '') return;
        setBusy(true);
        try {
          // The filters are sent to the host, not applied in the browser: the list is capped there,
          // so filtering locally would hide cards that a query was supposed to surface.
          const payload = await call('/api/task-memory/cards', {
            query: {
              workspace,
              tiers: tiersForMode(filterMode).join(','),
              from,
              to,
            },
          });
          setCards(Array.isArray(payload.cards) ? payload.cards : []);
          if (Number.isFinite(payload.total)) setTotal(payload.total);
          // The first response for a workspace supplies the filter defaults: which tiers the
          // deployment opens on, and the span of dates that actually exist.
          if (tiers === null && Array.isArray(payload.defaultTiers)) setTiers(new Set(payload.defaultTiers));
          if (Array.isArray(payload.tierDays)) setDays(payload.tierDays);
          if (payload.dateBounds !== undefined) setBounds(payload.dateBounds);
          if (payload.modeRanges !== undefined) {
            setModeRanges(payload.modeRanges);
            // The opening view applies its own window too, so the pickers never start out describing
            // a wider period than the tier filter is showing. Only an untouched range is seeded:
            // after that the range is the user's (or a mode switch's) to set.
            const opening = payload.modeRanges.default;
            if (opening !== undefined) {
              setFrom((current) => (current === '' ? opening.from : current));
              setTo((current) => (current === '' ? opening.to : current));
            }
          }
          setNotice(null);
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
          setLoading(false);
        }
      }, [workspace, filterMode, tiers, from, to]);

      React.useEffect(() => {
        void reload();
      }, [reload]);

      const openCard = async (name) => {
        setBusy(true);
        try {
          const payload = await call('/api/task-memory/card', { query: { workspace, name } });
          setSelected(payload);
          setDraft({
            name: payload.card.name,
            description: payload.card.description,
            whenToUse: payload.card.whenToUse ?? '',
            triggers: (payload.card.triggers ?? []).join(', '),
            tags: (payload.card.tags ?? []).join(', '),
            status: payload.card.status,
            published: payload.card.published === true,
            body: payload.body,
          });
          setNotice(null);
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
        }
      };

      const newCard = () => {
        setSelected(null);
        setDraft({ name: '', description: '', whenToUse: '', triggers: '', tags: '', status: 'verified', published: false, body: '' });
        setNotice(null);
      };

      const splitList = (value) => String(value ?? '').split(/[,，、\n]/).map((item) => item.trim()).filter((item) => item !== '');

      const save = async () => {
        if (draft === null) return;
        setBusy(true);
        try {
          const payload = await call('/api/task-memory/save', {
            body: {
              workspace,
              mode: selected === null ? 'create' : 'update',
              name: draft.name.trim(),
              description: draft.description.trim(),
              whenToUse: draft.whenToUse.trim(),
              triggers: splitList(draft.triggers),
              tags: splitList(draft.tags),
              status: draft.status,
              published: draft.published === true,
              body: draft.body,
            },
          });
          done(payload.outcome === 'created' ? `已创建 ${payload.card.name}` : `已保存 ${payload.card.name}`);
          setSelected({ card: payload.card, body: draft.body });
          await reload();
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
        }
      };

      const remove = async () => {
        if (draft === null || selected === null) return;
        if (!window.confirm(`删除记忆卡 ${draft.name}？它会连同卡片正文、附带的文件一起删除，无法恢复。`)) return;
        setBusy(true);
        try {
          await call('/api/task-memory/delete', { body: { workspace, name: draft.name } });
          done(`已删除 ${draft.name}`);
          setSelected(null);
          setDraft(null);
          await reload();
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
        }
      };

      const search = async () => {
        if (query.trim() === '') {
          void reload();
          return;
        }
        setBusy(true);
        try {
          const payload = await call('/api/task-memory/search', { query: { workspace, q: query } });
          const names = new Set((payload.matches ?? []).map((match) => match.name));
          setCards((current) => current.filter((card) => names.has(card.name)));
          done(`检索「${query}」命中 ${names.size} 张卡`);
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
        }
      };

      /**
       * Review and clean up the forgotten tier.
       *
       * Forgotten cards are never removed automatically — a memory that deletes itself is worse than
       * one that gets crowded — so cleanup is a two-step act by a human: list them, then confirm.
       */
      const reviewForgotten = async () => {
        setBusy(true);
        try {
          const payload = await call('/api/task-memory/forgotten', { query: { workspace } });
          const rows = Array.isArray(payload.forgotten) ? payload.forgotten : [];
          if (rows.length === 0) {
            done('没有遗忘档的卡片。');
            return;
          }
          const list = rows.map((row) => `· ${row.name}（${row.ageLabel}）`).join('\n');
          if (!window.confirm(`遗忘档（超过一年未用）共 ${rows.length} 张：\n\n${list}\n\n删除它们？此操作不可撤销。`)) return;
          const purged = await call('/api/task-memory/purge', {
            body: { workspace, names: rows.map((row) => row.name) },
          });
          done(`已清理 ${purged.removed.length} 张${purged.failed.length > 0 ? `，${purged.failed.length} 张失败` : ''}。`);
          setSelected(null);
          setDraft(null);
          await reload();
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
        }
      };

      /**
       * Import the previous file-backed memory of the selected workspace.
       *
       * Three steps with three different risks, so each one is shown before it happens: preview
       * (touches nothing), import (writes), and deleting the source files (irreversible, and never
       * offered before a successful import).
       */
      const migrateLegacy = async () => {
        setBusy(true);
        try {
          const preview = await call('/api/task-memory/legacy/preview', { query: { workspace } });
          if (preview.found !== true) {
            done('这个工作区没有旧版记忆文件（没有 .dsh/task-memory/notes 目录）。');
            return;
          }
          const { totals } = preview;
          if (totals.cards === 0) {
            done(`找到旧版目录但没有可导入的卡片${totals.unreadable > 0 ? `（${totals.unreadable} 张读取失败）` : ''}。`);
            return;
          }
          const lines = [
            `工作区：${workspace}`,
            `旧版位置：${preview.notes}`,
            '',
            `将导入 ${totals.cards} 张卡片（新建 ${totals.create}，已存在 ${totals.conflict}），附件 ${totals.assets} 个。`,
          ];
          if (totals.unreadable > 0) lines.push(`另有 ${totals.unreadable} 张无法解析，会被跳过。`);
          lines.push('', '已存在的同名卡片不会被覆盖。继续导入？');
          if (!window.confirm(lines.join('\n'))) return;

          const imported = await call('/api/task-memory/legacy/import', {
            body: { workspace, overwrite: false },
          });
          const summary = `已导入 ${imported.imported.length} 张`
            + (imported.skipped.length > 0 ? `，跳过 ${imported.skipped.length} 张（已存在）` : '')
            + (imported.failed.length > 0 ? `，失败 ${imported.failed.length} 张` : '')
            + '。';
          await reload();

          // Deleting the source is a separate confirmation, and only after the import reported what
          // it actually wrote — the user is agreeing to lose files, so they see the result first.
          const sources = (imported.sources ?? []).map((path) => `· ${path}`).join('\n');
          if (imported.imported.length > 0 && window.confirm(
            `${summary}\n\n数据库里已经有这些卡片了。要删除旧版文件吗？\n\n${sources}\n\n此操作不可撤销。`,
          )) {
            const removed = await call('/api/task-memory/legacy/remove', { body: { workspace } });
            done(`${summary} 已删除旧版文件（${removed.removed.length} 项）。`);
          } else {
            done(`${summary} 旧版文件保留在原处。`);
          }
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
        }
      };

      const header = h('div', { className: 'tm-head' },
        h('div', { className: 'tm-titles' },
          h('h1', { className: 'tm-h1' }, '任务记忆'),
          h('div', { className: 'tm-sub' }, workspace === '' ? '选择工作区' : workspace)),
        h('div', { className: 'tm-actions' },
          h('button', { className: 'tm-btn', onClick: newCard, disabled: workspace === '' }, '新建卡片'),
          h('button', { className: 'tm-btn', onClick: () => void reviewForgotten(), disabled: busy || workspace === '' }, '清理遗忘'),
          h('button', { className: 'tm-btn', onClick: () => void migrateLegacy(), disabled: busy || workspace === '' }, '兼容旧版记忆'),
          h('button', { className: 'tm-btn', onClick: () => void reload(), disabled: busy || workspace === '' }, '刷新')));

      const picker = h('div', { className: 'tm-toolbar' },
        h(Dropdown, {
          value: workspace,
          disabled: workspaces.length === 0,
          ariaLabel: '选择工作区',
          options: workspaces.map((row) => ({ value: row.path, label: `${row.title}（${row.cards} 张卡）` })),
          onChange: (next) => {
            setWorkspace(next);
            setSelected(null);
            setDraft(null);
          },
        }),
        h(Dropdown, {
          value: filterMode,
          ariaLabel: '档位筛选',
          options: filterModes.map((mode) => ({ value: mode.value, label: mode.label })),
          onChange: (next) => chooseMode(next),
        }),
        h('input', {
          className: 'tm-input', placeholder: '检索正文…', value: query,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') void search();
          },
        }),
        h('button', { className: 'tm-btn', onClick: () => void search(), disabled: busy || workspace === '' }, '检索'),
        h('button', {
          className: 'tm-btn',
          disabled: busy || workspace === '',
          onClick: () => chooseMode('all'),
        }, '全时段'));

      // Date range. The pickers are bounded by the real span of stored dates, and each day that
      // actually holds a card is marked — otherwise a date picker over a sparse memory is a guessing
      // game about which days are even worth looking at.
      const range = h('div', { className: 'tm-toolbar tm-range' },
        h('label', { className: 'tm-range-label' }, '起'),
        h('input', {
          className: 'tm-input tm-date',
          type: 'date',
          value: from,
          min: bounds.from ?? undefined,
          max: bounds.to ?? undefined,
          onChange: (event) => setFrom(event.target.value),
          // Days that hold a card are tinted through the picker's own calendar cells, which the
          // theme cannot reach from here; the chips below carry the same information reliably.
          list: 'tm-date-marks',
        }),
        h('label', { className: 'tm-range-label' }, '止'),
        h('input', {
          className: 'tm-input tm-date',
          type: 'date',
          value: to,
          min: bounds.from ?? undefined,
          max: bounds.to ?? undefined,
          onChange: (event) => setTo(event.target.value),
        }),
        h('span', { className: 'tm-range-hint' },
          bounds.from === '' ? '（暂无卡片）' : `数据范围 ${bounds.from} ~ ${bounds.to}`));

      // Which days hold cards, shown as a compact strip of counts. This is the "明显标记" part: a
      // date input's calendar cannot be styled, so the information is surfaced beside it instead.
      const dayStrip = days.length === 0 ? null : h('div', { className: 'tm-days' },
        days.map((day) => h('button', {
          key: day.date,
          type: 'button',
          className: `tm-day${from === day.date && to === day.date ? ' tm-day-active' : ''}`,
          title: `${day.date}：${day.count} 张`,
          onClick: () => { setFrom(day.date); setTo(day.date); },
        }, h('span', { className: 'tm-day-date' }, day.date.slice(5)), h('span', { className: 'tm-day-count' }, String(day.count)))));

      const list = loading
        ? h('div', { className: 'tm-empty' }, '读取中…')
        : cards.length === 0
          ? h('div', { className: 'tm-empty' },
            total === 0
              ? '这个工作区还没有任务记忆卡。'
              : '当前筛选下没有卡片。',
            h('br'),
            total === 0
              ? '任务结束后，满足条件的做法会被自动记录。'
              : `这个工作区共有 ${total} 张卡，换个档位或放宽日期就能看到。`)
          : h('div', { className: 'tm-list' }, cards.flatMap((card, position) => {
            // Group headers are inserted where the tier changes. The list arrives already tier-sorted
            // from the host, so this only has to notice the boundary.
            const previous = position === 0 ? null : cards[position - 1];
            const nodes = [];
            if (previous === null || previous.tier !== card.tier) {
              const count = cards.filter((row) => row.tier === card.tier).length;
              nodes.push(h('div', { key: `head-${card.tier}`, className: 'tm-group' },
                h('span', { className: 'tm-group-name' }, card.tierLabel),
                h('span', { className: 'tm-group-count' }, `${count} 张`)));
            }
            nodes.push(h('div', {
              key: card.name,
              className: `tm-card${draft !== null && draft.name === card.name ? ' tm-card-active' : ''}`,
              onClick: () => void openCard(card.name),
            },
              h('div', { className: 'tm-card-top' },
                h('span', { className: 'tm-name' }, card.name)),
              h('div', { className: 'tm-desc' }, card.description),
              h('div', { className: 'tm-meta' },
                h('span', {}, `${card.ageLabel}`),
                h('span', {}, `r${card.revision}`),
                h('span', {}, `加载 ${card.hits} 次`)),
              h('div', { className: 'tm-badges' },
                h('span', { className: `tm-badge ${card.status === 'verified' ? 'tm-badge-ok' : 'tm-badge-warn'}` }, statusLabel(card.status)),
                card.published ? h('span', { className: 'tm-badge tm-badge-pub' }, '技能') : null),
              (card.triggers ?? []).length > 0
                ? h('div', { className: 'tm-meta' }, card.triggers.map((trigger) => h('span', { key: trigger, className: 'tm-tag' }, trigger)))
                : null));
            return nodes;
          }));

      const editor = draft === null ? null : h('div', {},
        h('div', { className: 'tm-detail-head' },
          h('h2', { className: 'tm-detail-title' }, selected === null ? '新建记忆卡' : draft.name),
          h('div', { className: 'tm-actions' },
            h('button', { className: 'tm-btn tm-btn-primary', onClick: () => void save(), disabled: busy }, '保存'),
            selected !== null ? h('button', { className: 'tm-btn tm-btn-danger', onClick: () => void remove(), disabled: busy }, '删除') : null)),
        // A card is a database row, so there is no file to name here; the tier and age say where it
        // sits in the library, which is what a path used to be read for.
        selected !== null
          ? h('div', { className: 'tm-sub', style: { marginBottom: '12px' } },
            h('span', { className: 'tm-badge tm-badge-ok' }, `${selected.card.tierLabel} · ${selected.card.ageLabel}`),
            ' ',
            `更新于 ${selected.card.updated}`)
          : null,
        h('div', { className: 'tm-row' },
          h('div', { className: 'tm-field' },
            h('label', { className: 'tm-label' }, '名字（kebab-case，创建后不可改）'),
            h('input', {
              className: 'tm-input', value: draft.name, disabled: selected !== null,
              onChange: (event) => setDraft({ ...draft, name: event.target.value }),
            })),
          h('div', { className: 'tm-field' },
            h('label', { className: 'tm-label' }, '状态'),
            h(Dropdown, {
              value: draft.status,
              ariaLabel: '状态',
              options: ['verified', 'draft', 'stale'].map((status) => ({ value: status, label: statusLabel(status) })),
              onChange: (next) => setDraft({ ...draft, status: next }),
            }))),
        h('div', { className: 'tm-field' },
          h('label', { className: 'tm-check' },
            h('input', {
              type: 'checkbox',
              checked: draft.published === true,
              onChange: (event) => setDraft({ ...draft, published: event.target.checked }),
            }),
            h('span', {}, '作为技能上架'),
            h('span', { className: 'tm-hint' }, '上架后会出现在技能中心；不上架也能被任务记忆索引和工具检索到。'))),
        h('div', { className: 'tm-field' },
          h('label', { className: 'tm-label' }, '描述（索引里显示的这一行）'),
          h('input', {
            className: 'tm-input', value: draft.description,
            onChange: (event) => setDraft({ ...draft, description: event.target.value }),
          })),
        h('div', { className: 'tm-field' },
          h('label', { className: 'tm-label' }, '适用时机'),
          h('input', {
            className: 'tm-input', value: draft.whenToUse,
            onChange: (event) => setDraft({ ...draft, whenToUse: event.target.value }),
          })),
        h('div', { className: 'tm-row' },
          h('div', { className: 'tm-field' },
            h('label', { className: 'tm-label' }, '触发词（逗号分隔）'),
            h('input', {
              className: 'tm-input', value: draft.triggers,
              onChange: (event) => setDraft({ ...draft, triggers: event.target.value }),
            })),
          h('div', { className: 'tm-field' },
            h('label', { className: 'tm-label' }, '标签（逗号分隔）'),
            h('input', {
              className: 'tm-input', value: draft.tags,
              onChange: (event) => setDraft({ ...draft, tags: event.target.value }),
            }))),
        h('div', { className: 'tm-field' },
          h('label', { className: 'tm-label' }, '正文（Markdown，用 ## 分节）'),
          h('textarea', {
            className: 'tm-textarea', value: draft.body,
            onChange: (event) => setDraft({ ...draft, body: event.target.value }),
          })));

      return h('div', { className: 'tm-root' },
        header,
        picker,
        range,
        dayStrip,
        notice === null ? null : h('div', {
          className: `tm-notice ${notice.kind === 'err' ? 'tm-notice-err' : 'tm-notice-ok'}`,
        }, notice.text),
        h('div', { className: 'tm-columns' },
          h('div', { className: 'tm-list-col' }, list),
          h('div', { className: 'tm-detail-col' },
            editor === null
              ? h('div', { className: 'tm-detail-empty' }, '从左侧选择一张记忆卡查看详情，', h('br'), '或点右上角「新建卡片」。')
              : editor)));
    }

    return {
      inject: ['slots'],
      // Exposed for tests: the dropdown carries real interaction logic (keyboard, outside click,
      // focus return), and logic nobody can drive is logic nobody has checked. `Panel` is exported
      // for the same reason — its mode switch moves the date range, and that wiring is invisible to
      // any test that only checks the host's payload.
      Dropdown,
      SettingsSection,
      Panel,
      apply(ctx) {
        ctx.effect(() => installStyles(), 'task-memory: panel styles');
        ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
          name: 'sidebar.panellist',
          id: PANEL_ID,
          order: 30,
          label: () => '任务记忆',
        }, PanelIcon));
        ctx.slots.inject('main', () => ctx.slots.register({
          name: 'main',
          key: PANEL_ID,
        }, Panel));
        // The settings section. The host renders its own config forms only for plugins that declare
        // a schemastery Config with volatile fields; this plugin has no schema, so it contributes a
        // section and reads/writes the same configuration through its own routes.
        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section',
          id: 'task-memory',
          order: 60,
          label: () => '任务记忆',
        }, SettingsSection));
      },
    };
  },
});

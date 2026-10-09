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
.tm-root{height:100%;overflow:auto;padding:24px 28px 48px;box-sizing:border-box;color:var(--dsw-alias-label-primary);background:var(--dsw-alias-bg-base);font-size:14px}
.tm-head{display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:8px}
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
.tm-toolbar{display:flex;gap:8px;align-items:center;margin:16px 0;flex-wrap:wrap}
.tm-input,.tm-textarea{box-sizing:border-box;border:0.5px solid var(--dsw-alias-border-l4);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md);padding:6px 10px;font:inherit;font-size:13px}
.tm-input{min-width:240px;flex:1;height:32px}
.tm-input:focus,.tm-textarea:focus{outline:none;border-color:var(--dsw-alias-state-business-primary)}
.tm-input::placeholder{color:var(--dsw-alias-label-dimmed)}
.tm-textarea{width:100%;min-height:260px;font-family:var(--ds-font-family-code);font-size:13px;line-height:20px;resize:vertical}
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
.tm-field{margin-bottom:12px}
.tm-label{display:block;font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:4px}
.tm-list{display:flex;flex-direction:column;gap:8px;margin-top:8px}
.tm-card{border:1px solid var(--dsw-alias-border-l2);border-radius:10px;padding:12px 14px;background:var(--dsw-alias-bg-base);cursor:pointer}
.tm-card:hover{background:var(--dsw-alias-interactive-bg-hover)}
.tm-card-active{border-color:var(--dsw-alias-state-business-primary)}
.tm-card-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.tm-name{font-family:var(--ds-font-family-code);font-size:13px;font-weight:600}
.tm-desc{margin-top:4px;line-height:20px}
.tm-meta{margin-top:6px;font-size:12px;color:var(--dsw-alias-label-secondary);display:flex;gap:12px;flex-wrap:wrap}
.tm-tag{display:inline-block;border-radius:6px;padding:1px 6px;font-size:11px;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary);margin-right:4px}
.tm-badge{font-size:11px;border-radius:6px;padding:1px 6px}
.tm-badge-warn{color:var(--dsw-alias-state-warn-primary);background:var(--dsw-alias-interactive-bg-hover)}
.tm-badge-err{color:var(--dsw-alias-state-error-primary);background:var(--dsw-alias-interactive-bg-hover)}
.tm-empty{padding:32px 8px;color:var(--dsw-alias-label-secondary);text-align:center;line-height:22px}
.tm-notice{margin:12px 0;padding:10px 12px;border-radius:8px;font-size:13px;line-height:20px}
.tm-notice-err{color:var(--dsw-alias-state-error-primary);border:1px solid var(--dsw-alias-state-error-primary)}
.tm-notice-ok{color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l3)}
.tm-editor{margin-top:16px;border-top:1px solid var(--dsw-alias-border-l2);padding-top:16px}
.tm-row{display:flex;gap:8px;flex-wrap:wrap}
.tm-row>*{flex:1;min-width:180px}
.tm-icon{width:18px;height:18px;display:block}
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
      const [selected, setSelected] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [query, setQuery] = React.useState('');
      const [busy, setBusy] = React.useState(false);
      const [notice, setNotice] = React.useState(null);
      const [loading, setLoading] = React.useState(true);

      const fail = (error) => setNotice({ kind: 'err', text: error instanceof Error ? error.message : String(error) });
      const done = (text) => setNotice({ kind: 'ok', text });

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
          const payload = await call('/api/task-memory/cards', { query: { workspace } });
          setCards(Array.isArray(payload.cards) ? payload.cards : []);
          setNotice(null);
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
          setLoading(false);
        }
      }, [workspace]);

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
        setDraft({ name: '', description: '', whenToUse: '', triggers: '', tags: '', status: 'verified', body: '' });
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
              body: draft.body,
            },
          });
          done(payload.outcome === 'created' ? `已创建 ${payload.card.name}` : `已保存 ${payload.card.name}`);
          setSelected({ card: payload.card, body: draft.body, raw: '', assets: [], path: '' });
          await reload();
        } catch (error) {
          fail(error);
        } finally {
          setBusy(false);
        }
      };

      const remove = async () => {
        if (draft === null || selected === null) return;
        if (!window.confirm(`删除记忆卡 ${draft.name}？这会连同它的 assets 目录一起删除。`)) return;
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

      const header = h('div', { className: 'tm-head' },
        h('div', { className: 'tm-titles' },
          h('h1', { className: 'tm-h1' }, '任务记忆'),
          h('div', { className: 'tm-sub' }, workspace === '' ? '选择工作区' : workspace)),
        h('div', { className: 'tm-actions' },
          h('button', { className: 'tm-btn', onClick: newCard, disabled: workspace === '' }, '新建卡片'),
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
        h('input', {
          className: 'tm-input', placeholder: '检索正文…', value: query,
          onChange: (event) => setQuery(event.target.value),
          onKeyDown: (event) => {
            if (event.key === 'Enter') void search();
          },
        }),
        h('button', { className: 'tm-btn', onClick: () => void search(), disabled: busy || workspace === '' }, '检索'));

      const list = loading
        ? h('div', { className: 'tm-empty' }, '读取中…')
        : cards.length === 0
          ? h('div', { className: 'tm-empty' }, '这个工作区还没有任务记忆卡。', h('br'), '任务结束后，满足条件的做法会被自动记录。')
          : h('div', { className: 'tm-list' }, cards.map((card) => h('div', {
            key: card.name,
            className: `tm-card${draft !== null && draft.name === card.name ? ' tm-card-active' : ''}`,
            onClick: () => void openCard(card.name),
          },
            h('div', { className: 'tm-card-top' },
              h('span', { className: 'tm-name' }, card.name),
              card.status !== 'verified' ? h('span', { className: 'tm-badge tm-badge-warn' }, card.status) : null,
              card.problem !== null ? h('span', { className: 'tm-badge tm-badge-err' }, '读取失败') : null),
            h('div', { className: 'tm-desc' }, card.description),
            h('div', { className: 'tm-meta' },
              h('span', {}, `更新 ${card.updated || '未知'}`),
              h('span', {}, `r${card.revision}`),
              h('span', {}, `加载 ${card.hits} 次`),
              (card.triggers ?? []).length > 0 ? h('span', {}, card.triggers.map((trigger) => h('span', { key: trigger, className: 'tm-tag' }, trigger))) : null))));

      const editor = draft === null ? null : h('div', { className: 'tm-editor' },
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
              options: ['verified', 'draft', 'stale'].map((status) => ({ value: status, label: status })),
              onChange: (next) => setDraft({ ...draft, status: next }),
            }))),
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
          })),
        h('div', { className: 'tm-actions' },
          h('button', { className: 'tm-btn tm-btn-primary', onClick: () => void save(), disabled: busy }, '保存'),
          selected !== null ? h('button', { className: 'tm-btn tm-btn-danger', onClick: () => void remove(), disabled: busy }, '删除') : null,
          selected !== null && selected.path !== '' ? h('span', { className: 'tm-meta' }, selected.path) : null));

      return h('div', { className: 'tm-root' },
        header,
        picker,
        notice === null ? null : h('div', {
          className: `tm-notice ${notice.kind === 'err' ? 'tm-notice-err' : 'tm-notice-ok'}`,
        }, notice.text),
        list,
        editor);
    }

    return {
      inject: ['slots'],
      // Exposed for tests: the dropdown carries real interaction logic (keyboard, outside click,
      // focus return), and logic nobody can drive is logic nobody has checked.
      Dropdown,
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
      },
    };
  },
});

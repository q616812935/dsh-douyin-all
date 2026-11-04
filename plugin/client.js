/*! dsh-douyin-all · Copyright (c) 2026 dsh-douyin-all authors · All rights reserved.
 *  Proprietary and confidential — UNLICENSED. Modification, redistribution and
 *  republication are prohibited. See LICENSE. */
// dsh-douyin-all 设置页
// 视觉规范照 DSH 自身设置页：卡片分区、统一下拉/输入框、36×20 滑块开关。
// 数据全部走 /api/douyin-all/*（GET /state 读，POST /config 改）。
window.__ModuleLoader__.load({
  id: 'dsh-douyin-all',
  factory(require) {
    const React = require('react');
    const { useState, useEffect, useRef } = React;
    const h = React.createElement;

    const C = {
      line: 'var(--dsw-alias-border-l, rgba(0,0,0,0.10))',
      text: 'var(--dsw-alias-label-primary, #0f1115)',
      text2: 'var(--dsw-alias-label-secondary, rgba(15,17,21,0.72))',
      text3: 'var(--dsw-alias-label-tertiary, rgba(15,17,21,0.45))',
      card: 'var(--dsw-alias-bg-base, #ffffff)',
      brand: 'var(--dsw-alias-brand-primary, #0f1115)',
      danger: '#c0392b',
      ok: '#1e8e5a',
    };

    const ctlBase = {
      height: 32, borderRadius: 8, border: '1px solid ' + C.line,
      background: 'transparent', color: C.text, padding: '0 8px',
      fontSize: 13, outline: 'none', fontFamily: 'inherit', boxSizing: 'border-box',
    };

    // DSH 同款开关：36×20 轨道 + 16px 拇指
    function Switch({ checked, onChange }) {
      return h('button', {
        type: 'button', role: 'switch', 'aria-checked': checked ? 'true' : 'false',
        onClick: () => onChange(!checked),
        style: {
          position: 'relative', flex: '0 0 auto', width: 36, height: 20, padding: 0,
          borderRadius: 10, border: 'none', cursor: 'pointer',
          background: checked ? C.brand : 'rgba(0,0,0,0.18)',
          transition: 'background .15s',
        },
      }, h('span', {
        style: {
          position: 'absolute', top: 2, left: checked ? 18 : 2, width: 16, height: 16,
          borderRadius: 8, background: '#fff', transition: 'left .15s',
          boxShadow: '0 1px 2px rgba(0,0,0,.2)',
        },
      }));
    }

    function Row({ label, hint, children }) {
      return h('div', {
        style: {
          display: 'flex', alignItems: 'center', justifyContent: 'space-between',
          gap: 16, minHeight: 40, padding: '6px 0',
        },
      },
        h('div', { style: { minWidth: 0 } },
          h('div', { style: { fontSize: 13, color: C.text, lineHeight: '20px' } }, label),
          hint ? h('div', { style: { fontSize: 12, color: C.text3, lineHeight: '18px' } }, hint) : null,
        ),
        h('div', { style: { flex: '0 0 auto', display: 'flex', alignItems: 'center', gap: 8 } }, children),
      );
    }

    function Card({ title, anchor, children }) {
      return h('div', {
        'data-dya': anchor || undefined,
        id: anchor ? 'dyasec-' + anchor : undefined,
        style: { marginTop: 14, scrollMarginTop: 46 },
      },
        h('div', { style: { fontSize: 12.5, fontWeight: 600, color: C.text2, margin: '2px 0 8px 2px' } }, title),
        h('div', {
          style: { border: '1px solid ' + C.line, borderRadius: 12, background: C.card, padding: '4px 16px' },
        }, children),
      );
    }

    const Btn = ({ onClick, disabled, children, primary }) => h('button', {
      type: 'button', onClick, disabled,
      style: Object.assign({}, ctlBase, {
        width: 'auto', padding: '0 12px',
        cursor: disabled ? 'default' : 'pointer',
        color: primary ? '#fff' : C.text2,
        background: primary ? C.brand : 'transparent',
        borderColor: primary ? C.brand : C.line,
        opacity: disabled ? 0.55 : 1,
      }),
    }, children);

    const Num = ({ value, onChange, min, max, width = 72 }) => h('input', {
      type: 'number', value: value === undefined || value === null ? '' : value,
      min, max,
      onChange: (e) => onChange(e.target.value === '' ? '' : Number(e.target.value)),
      style: Object.assign({}, ctlBase, { width }),
    });

    const Txt = ({ value, onChange, placeholder, width = 200 }) => h('input', {
      type: 'text', value: value || '', placeholder: placeholder || '',
      onChange: (e) => onChange(e.target.value),
      style: Object.assign({}, ctlBase, { width }),
    });

    const Sel = ({ value, onChange, options, width = 200 }) => h('select', {
      value: value || '', onChange: (e) => onChange(e.target.value),
      style: Object.assign({}, ctlBase, { width }),
    }, ...options.map((o) => h('option', { key: o.value, value: o.value }, o.label)));

    const TAG = (t, color) => h('span', {
      style: {
        fontSize: 11, lineHeight: '18px', padding: '0 7px', borderRadius: 9,
        color: color || C.text2, background: 'rgba(0,0,0,0.05)',
      },
    }, t);

    // ── 面板 ────────────────────────────────────────────────────────────
    // 后端 soul.memories 给的是 { total, archived, private, people }，早期版本给过数组，两种都吃
    function memoryCount(m) {
      if (Array.isArray(m)) return m.length;
      const v = Number(m && m.total);
      return Number.isFinite(v) ? v : 0;
    }

    function Panel() {
      const [st, setSt] = useState(null);
      const [note, setNote] = useState('');
      const [busy, setBusy] = useState('');
      const [tab, setTab] = useState('basic');
      const [events, setEvents] = useState(null);
      const [report, setReport] = useState(null);
      const cardRef = useRef('');

      const load = () => fetch('/api/douyin-all/state')
        .then((r) => r.json())
        .then((d) => { if (d.ok) setSt(d); else setNote('读状态失败：' + (d.error || '未知')); })
        .catch(() => setNote('读状态失败：接口没返回（宿主报错，见 DSH 日志）'));

      useEffect(() => {
        load();
        const t = setInterval(() => {
          fetch('/api/douyin-all/state').then((r) => r.json()).then((d) => { if (d.ok) setSt(d) }).catch(() => {});
        }, 8000);
        return () => clearInterval(t);
      }, []);

      const save = (patch) => {
        fetch('/api/douyin-all/config', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
        }).then((r) => r.json())
          .then((d) => {
            if (!d.ok) return setNote('保存失败：' + (d.error || '未知'));
            setSt((cur) => (cur ? Object.assign({}, cur, { config: d.config }) : cur));
            setNote('已保存');
          })
          .catch(() => setNote('保存失败：接口没返回'));
      };
      // 只改配置里的某个子对象，别把整棵 config 写回去（多标签同时改会互相覆盖）
      const patch = (obj) => save(Object.assign({}, st.config, obj));

      const runOnce = (only) => {
        if (busy) return;
        setBusy('run');
        setNote(only ? ('正在只跑 ' + only + '（一两分钟）…') : '正在跑一轮（一两分钟）…');
        fetch('/api/douyin-all/run', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ only }),
        }).then((r) => r.json())
          .then((d) => {
            if (!d.ok) return setNote('跑失败：' + (d.error || '未知'));
            const parts = d.result && d.result.parts ? d.result.parts : {};
            const line = Object.entries(parts).map(([k, v]) => k + '：' + (v && v.ok ? 'ok' : '失败') + (v && v.why ? '（' + v.why + '）' : '')).join('；');
            setNote('跑完了。' + (line || ''));
            load();
          })
          .catch(() => setNote('跑失败：接口没返回'))
          .then(() => setBusy(''));
      };

      const loadEvents = () => {
        setBusy('ev');
        fetch('/api/douyin-all/events?limit=40').then((r) => r.json())
          .then((d) => setEvents(d.events || []))
          .catch(() => setNote('读事件失败'))
          .then(() => setBusy(''));
      };
      const loadReport = () => {
        setBusy('rp');
        fetch('/api/douyin-all/report?days=1').then((r) => r.json())
          .then((d) => setReport(d))
          .catch(() => setNote('读日报失败'))
          .then(() => setBusy(''));
      };
      const health = () => {
        setBusy('hc');
        setNote('正在检查浏览器…');
        fetch('/api/douyin-all/health').then((r) => r.json())
          .then((d) => {
            const b = d.browser || {};
            setNote(d.ok
              ? '浏览器正常：9334 上 ' + (b.pages || '?') + ' 个页面'
              : '浏览器有问题：' + (b.why || '未知') + '（下一轮会自动重建）');
          })
          .catch(() => setNote('检查失败：接口没返回'))
          .then(() => setBusy(''));
      };

      if (!st || !st.config) {
        return h('div', { style: { padding: 16, fontSize: 13, color: note ? C.danger : C.text3 } }, note || '加载中…');
      }

      const cfg = st.config;
      const dm = cfg.dm || {};
      const cm = cfg.comments || {};
      const fd = cfg.feed || {};
      const rp = cfg.report || {};
      const auto = st.auto || {};
      const modelReady = !!st.modelConfigured;
      const modelOpts = [{ value: '', label: '跟随宿主设置（推荐）' }].concat(
        (st.models || []).map((m) => ({ value: m.provider + '|' + m.model, label: m.providerName + ' / ' + (m.name || m.model) })),
      );
      const curModel = cfg.model && cfg.model.provider ? cfg.model.provider + '|' + cfg.model.model : '';

      const tabs = [
        { k: 'basic', label: '基础' },
        { k: 'dm', label: '私信' },
        { k: 'comments', label: '评论' },
        { k: 'feed', label: '刷视频' },
        { k: 'maint', label: '自检与日报' },
      ];
      const jump = (anchor) => {
        try {
          const el = document.getElementById('dyasec-' + anchor);
          if (el && el.scrollIntoView) el.scrollIntoView({ block: 'start', behavior: 'smooth' });
        } catch { /* 跳不过去就算了 */ }
      };

      return h('div', { 'data-dya-panel': '1', style: { paddingBottom: 8 } },

        // 顶部状态条
        h('div', {
          style: {
            display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8,
            padding: '10px 0 2px', fontSize: 12.5, color: C.text2,
          },
        },
          TAG(cfg.enabled ? '哨兵运行中' : '已暂停', cfg.enabled ? C.ok : C.text3),
          TAG(modelReady ? ('模型 ' + cfg.model.model) : '跟随宿主模型', modelReady ? C.text2 : C.text3),
          auto.running ? TAG('正在跑一轮', C.ok) : (auto.nextAt ? TAG('下次 ' + new Date(auto.nextAt).toLocaleTimeString()) : TAG('未调度')),
          st.soul ? TAG('记忆 ' + memoryCount(st.soul.memories) + ' 条') : null,
          st.soul && st.soul.hasDiaryToday ? TAG('今天写过日记') : null,
        ),

        // Tab 条（纯前端切换，避免一次把所有卡片堆出来）
        h('div', { style: { display: 'flex', gap: 6, padding: '6px 0 0' } },
          ...tabs.map((t) => h('button', {
            key: t.k, type: 'button', onClick: () => setTab(t.k),
            style: Object.assign({}, ctlBase, {
              width: 'auto', padding: '0 12px', cursor: 'pointer',
              background: tab === t.k ? 'rgba(0,0,0,0.06)' : 'transparent',
              color: tab === t.k ? C.text : C.text3,
              fontWeight: tab === t.k ? 600 : 400,
            }),
          }, t.label)),
        ),

        // ── 基础 ──
        tab === 'basic' ? h('div', null,
          h(Card, { title: '总开关', anchor: 'main' },
            h(Row, { label: '自动陪伴', hint: '关掉后不再自动跑，但工具和设置仍然可用' },
              h(Switch, { checked: !!cfg.enabled, onChange: (v) => patch({ enabled: v }) }),
            ),
            h(Row, { label: '多久巡检一次', hint: '分钟；一轮可能跑 1–3 分钟，间隔太小会排队' },
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                h(Num, { value: cfg.intervalSeconds, min: 60, max: 3600, width: 84, onChange: (v) => patch({ intervalSeconds: Math.max(60, Number(v) || 60) }) }),
                h('span', { style: { fontSize: 12, color: C.text3 } }, '秒'),
              ),
            ),
          ),

          h(Card, { title: '模型', anchor: 'model' },
            h(Row, { label: '用哪个模型', hint: '默认跟随 DSH 设置页选的模型，这里可以单独指定' },
              h(Sel, {
                value: curModel, options: modelOpts, width: 260,
                onChange: (v) => {
                  if (!v) return patch({ model: { provider: '', model: '' } });
                  const [provider, model] = v.split('|');
                  patch({ model: { provider, model } });
                },
              }),
            ),
            h(Row, { label: '兜底接口（可选）', hint: '填了就在宿主模型不可用时走这个 OpenAI 兼容端点' },
              h('span', { style: { display: 'inline-flex', gap: 6 } },
                h(Txt, {
                  value: (cfg.llm && cfg.llm.baseUrl) || '', placeholder: 'https://…/v1', width: 180,
                  onChange: (v) => patch({ llm: Object.assign({}, cfg.llm, { baseUrl: v }) }),
                }),
                h(Txt, {
                  value: (cfg.llm && cfg.llm.model) || '', placeholder: '模型名', width: 110,
                  onChange: (v) => patch({ llm: Object.assign({}, cfg.llm, { model: v }) }),
                }),
              ),
            ),
          ),

          h(Card, { title: '身份', anchor: 'id' },
            h(Row, { label: '抖音号昵称', hint: '她自己这个号在抖音上的名字（只用于显示与判断「谁发的」）' },
              h(Txt, { value: cfg.owner, width: 200, onChange: (v) => patch({ owner: v }) }),
            ),
            h(Row, { label: '对端昵称', hint: '私信只跟这个人聊；必须是左栏会话里显示的名字' },
              h(Txt, { value: cfg.peer, width: 200, onChange: (v) => patch({ peer: v }) }),
            ),
          ),

          h(Card, { title: '人格', anchor: 'persona' },
            h('div', { style: { fontSize: 12, color: C.text3, lineHeight: '20px', padding: '6px 0 2px' } },
              '当前人格：' + ((st.soul && st.soul.persona && st.soul.persona.name) || '默认大肥鱼') + '。改这里会立刻影响之后的每一句话。'),
            h(PersonaBox, { persona: st.soul && st.soul.persona, onSave: (p) => {
              setBusy('pe');
              fetch('/api/douyin-all/persona', {
                method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p),
              }).then((r) => r.json())
                .then(() => { setNote('人格已保存'); load(); })
                .catch(() => setNote('保存人格失败'))
                .then(() => setBusy(''));
            } }),
          ),
        ) : null,

        // ── 私信 ──
        tab === 'dm' ? h('div', null,
          h(Card, { title: '私信', anchor: 'dm' },
            h(Row, { label: '自动回复', hint: '收到对端的新消息就回' },
              h(Switch, { checked: !!dm.autoReply, onChange: (v) => patch({ dm: Object.assign({}, dm, { autoReply: v }) }) }),
            ),
            h(Row, { label: '主动开口', hint: '好久没人说话时自己发一句（每天限量）' },
              h(Switch, { checked: !!dm.speakFirst, onChange: (v) => patch({ dm: Object.assign({}, dm, { speakFirst: v }) }) }),
            ),
            h(Row, { label: '每天最多主动开口', hint: '条' },
              h(Num, { value: dm.perDay, min: 1, max: 200, onChange: (v) => patch({ dm: Object.assign({}, dm, { perDay: Number(v) || 1 }) }) }),
            ),
            h(Row, { label: '回复前停顿', hint: '毫秒；太像机器秒回反而容易被起疑' },
              h(Num, { value: dm.replyDelayMs, min: 0, max: 60000, width: 92, onChange: (v) => patch({ dm: Object.assign({}, dm, { replyDelayMs: Number(v) || 0 }) }) }),
            ),
            h(Row, { label: '回语音', hint: '用 TTS 合成语音发过去（对方听到的是真人声线）' },
              h(Switch, { checked: !!dm.voiceReply, onChange: (v) => patch({ dm: Object.assign({}, dm, { voiceReply: v }) }) }),
            ),
            h(Row, { label: '语音音色', hint: (st.voice && st.voice.deps && st.voice.deps.ok) ? '依赖就绪' : '语音依赖缺失，先跑自检' },
              h(Sel, {
                value: dm.voicePreset || '萝莉', width: 140,
                options: (st.voice && st.voice.presets ? st.voice.presets : ['萝莉']).map((p) => ({ value: p, label: p })),
                onChange: (v) => patch({ dm: Object.assign({}, dm, { voicePreset: v }) }),
              }),
            ),
          ),
        ) : null,

        // ── 评论 ──
        tab === 'comments' ? h('div', null,
          h(Card, { title: '回谁', anchor: 'cm' },
            h(Row, { label: '自己作品下的评论', hint: '别人评论了她的作品，她就回一句' },
              h(Switch, { checked: !!cm.selfWorks, onChange: (v) => patch({ comments: Object.assign({}, cm, { selfWorks: v }) }) }),
            ),
            h(Row, { label: '别人作品下的评论', hint: '去陌生人作品下搭话，风险高，默认关' },
              h(Switch, { checked: !!cm.others, onChange: (v) => patch({ comments: Object.assign({}, cm, { others: v }) }) }),
            ),
            h(Row, { label: '跳过这些昵称', hint: '逗号分隔（机器人、官方号之类）' },
              h(Txt, {
                value: (cm.skipNicks || []).join(','), width: 220,
                onChange: (v) => patch({ comments: Object.assign({}, cm, { skipNicks: v.split(/[,，]/).map((x) => x.trim()).filter(Boolean) }) }),
              }),
            ),
            h(Row, { label: '只看最近几天的作品', hint: '天；更老的作品不再扫' },
              h(Num, { value: cm.workMaxAgeDays, min: 1, max: 365, onChange: (v) => patch({ comments: Object.assign({}, cm, { workMaxAgeDays: Number(v) || 7 }) }) }),
            ),
          ),

          h(Card, { title: '闸门', anchor: 'gate' },
            h(Row, { label: '每条最多字数', hint: '抖音评论区太长会被折叠' },
              h(Num, { value: cm.maxChars, min: 1, max: 200, onChange: (v) => patch({ comments: Object.assign({}, cm, { maxChars: Number(v) || 60 }) }) }),
            ),
            h(Row, { label: '每小时 / 每天上限', hint: '条；超出就不再发' },
              h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 } },
                h(Num, { value: cm.perHour, min: 1, max: 60, width: 64, onChange: (v) => patch({ comments: Object.assign({}, cm, { perHour: Number(v) || 6 }) }) }),
                h('span', { style: { fontSize: 12, color: C.text3 } }, '/'),
                h(Num, { value: cm.perDay, min: 1, max: 500, width: 64, onChange: (v) => patch({ comments: Object.assign({}, cm, { perDay: Number(v) || 30 }) }) }),
              ),
            ),
            h(Row, { label: '同一个人多久内不重复回', hint: '小时；防止一句话来回刷' },
              h(Num, { value: cm.dedupeHours, min: 1, max: 720, width: 84, onChange: (v) => patch({ comments: Object.assign({}, cm, { dedupeHours: Number(v) || 168 }) }) }),
            ),
            h(Row, { label: '每轮最多回几条', hint: '条；一次扫太多容易被识别' },
              h(Num, { value: cm.maxPerRound, min: 1, max: 20, onChange: (v) => patch({ comments: Object.assign({}, cm, { maxPerRound: Number(v) || 3 }) }) }),
            ),
            h(Row, { label: '多久扫一次评论', hint: '分钟' },
              h(Num, { value: cm.scanMinutes, min: 1, max: 240, onChange: (v) => patch({ comments: Object.assign({}, cm, { scanMinutes: Number(v) || 10 }) }) }),
            ),
          ),
        ) : null,

        // ── 刷视频 ──
        tab === 'feed' ? h('div', null,
          h(Card, { title: '刷推荐流', anchor: 'feed' },
            h(Row, { label: '刷视频', hint: '在推荐流里挑她感兴趣的看' },
              h(Switch, { checked: !!fd.enabled, onChange: (v) => patch({ feed: Object.assign({}, fd, { enabled: v }) }) }),
            ),
            h(Row, { label: '一轮看几条', hint: '条' },
              h(Num, { value: fd.count, min: 1, max: 50, onChange: (v) => patch({ feed: Object.assign({}, fd, { count: Number(v) || 6 }) }) }),
            ),
            h(Row, { label: '挑到了就转发给对端', hint: '用私信发「一句话 + 链接」，送达可验证' },
              h(Switch, { checked: !!fd.shareToPeer, onChange: (v) => patch({ feed: Object.assign({}, fd, { shareToPeer: v }) }) }),
            ),
            h(Row, { label: '喜欢 / 不喜欢', hint: '逗号分隔的标签，影响打分' },
              h('span', { style: { display: 'inline-flex', gap: 6 } },
                h(Txt, {
                  value: (fd.like || []).join(','), width: 130, placeholder: '喜欢',
                  onChange: (v) => patch({ feed: Object.assign({}, fd, { like: v.split(/[,，]/).map((x) => x.trim()).filter(Boolean) }) }),
                }),
                h(Txt, {
                  value: (fd.dislike || []).join(','), width: 130, placeholder: '不喜欢',
                  onChange: (v) => patch({ feed: Object.assign({}, fd, { dislike: v.split(/[,，]/).map((x) => x.trim()).filter(Boolean) }) }),
                }),
              ),
            ),
          ),
        ) : null,

        // ── 自检与日报 ──
        tab === 'maint' ? h('div', null,
          h(Card, { title: '自检', anchor: 'health' },
            h(Row, { label: '浏览器活不活', hint: 'CDP 9334；空壳（没有 page target）会自动补一个' },
              h(Btn, { onClick: health, disabled: busy === 'hc' }, busy === 'hc' ? '检查中…' : '检查浏览器'),
            ),
            h(Row, { label: '立刻跑一轮', hint: '也可以只跑其中一段' },
              h('span', { style: { display: 'inline-flex', gap: 6 } },
                h(Btn, { onClick: () => runOnce(''), disabled: busy === 'run', primary: true }, busy === 'run' ? '跑着呢…' : '全部'),
                h(Btn, { onClick: () => runOnce('dm'), disabled: busy === 'run' }, '私信'),
                h(Btn, { onClick: () => runOnce('comments'), disabled: busy === 'run' }, '评论'),
                h(Btn, { onClick: () => runOnce('feed'), disabled: busy === 'run' }, '刷流'),
              ),
            ),
            h(Row, { label: '最近发生了什么', hint: 'events.jsonl 的尾部' },
              h(Btn, { onClick: loadEvents, disabled: busy === 'ev' }, busy === 'ev' ? '读…' : '看事件'),
            ),
            events ? h('div', { style: { maxHeight: 220, overflow: 'auto', fontSize: 12, color: C.text2, lineHeight: '19px', padding: '4px 0 10px' } },
              events.length
                ? events.slice().reverse().map((e, i) => h('div', { key: i }, (e.at || e.ts || '') + '  ' + (e.job || '') + '  ' + (e.ok === false ? '失败 ' : '') + (e.error || e.note || '')))
                : h('div', { style: { color: C.text3 } }, '（还没有事件）'),
            ) : null,
            h('div', { style: { fontSize: 12, color: C.text3, padding: '0 0 10px', wordBreak: 'break-all' } }, '状态目录：' + (st.stateRoot || '')),
          ),

          h(Card, { title: '观看日报', anchor: 'report' },
            h(Row, { label: '每天写日报', hint: '把当天看了什么、聊了什么、回了什么汇总成一小段' },
              h(Switch, { checked: !!rp.enabled, onChange: (v) => patch({ report: Object.assign({}, rp, { enabled: v }) }) }),
            ),
            h(Row, { label: '几点写', hint: '点' },
              h(Num, { value: rp.hour, min: 0, max: 23, onChange: (v) => patch({ report: Object.assign({}, rp, { hour: Math.max(0, Math.min(23, Number(v) || 22)) }) }) }),
            ),
            h(Row, { label: '看今天的日报', hint: '' },
              h(Btn, { onClick: loadReport, disabled: busy === 'rp' }, busy === 'rp' ? '读…' : '生成'),
            ),
            report ? h('div', { style: { fontSize: 12.5, color: C.text2, lineHeight: '21px', whiteSpace: 'pre-wrap', padding: '4px 0 10px' } },
              (report.report && (report.report.text || report.report)) || '（今天还没有记录）') : null,
            report && report.diary && report.diary.length
              ? h('div', { style: { fontSize: 12, color: C.text3, lineHeight: '20px', padding: '0 0 10px', whiteSpace: 'pre-wrap' } },
                '最近的日记：\n' + report.diary.slice(0, 5).map((d) => (d.day || '') + ' ' + (d.text || '')).join('\n'))
              : null,
          ),
        ) : null,

        note ? h('div', { style: { marginTop: 12, fontSize: 12, color: /失败|问题|缺失/.test(note) ? C.danger : C.text3 } }, note) : null,
      );
    }

    // 人格文本框：离开输入框才提交（和 DSH 自己的设置页一致）
    function PersonaBox({ persona, onSave }) {
      const [name, setName] = useState((persona && persona.name) || '大肥鱼');
      const [card, setCard] = useState((persona && (persona.card || persona.systemPrompt)) || '');
      const dirty = useRef(false);
      useEffect(() => {
        if (dirty.current) return;
        setName((persona && persona.name) || '大肥鱼');
        setCard((persona && (persona.card || persona.systemPrompt)) || '');
      }, [persona]);
      const commit = () => { if (dirty.current) { dirty.current = false; onSave({ name, card }) } };
      return h('div', { style: { padding: '2px 0 12px' } },
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 } },
          h('span', { style: { fontSize: 12.5, color: C.text2 } }, '名字'),
          h('input', {
            type: 'text', value: name,
            onChange: (e) => { dirty.current = true; setName(e.target.value) },
            onBlur: commit,
            style: Object.assign({}, ctlBase, { width: 160 }),
          }),
        ),
        h('textarea', {
          value: card, rows: 8, placeholder: '她是谁、脾气怎样、喜欢什么、怎么说话……留空就用内置的大肥鱼人格',
          onChange: (e) => { dirty.current = true; setCard(e.target.value) },
          onBlur: commit,
          style: {
            width: '100%', boxSizing: 'border-box', borderRadius: 8, border: '1px solid ' + C.line,
            background: 'transparent', color: C.text, padding: 10, fontSize: 13, lineHeight: '21px',
            outline: 'none', fontFamily: 'inherit', resize: 'vertical', minHeight: 120,
          },
        }),
      );
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('settings.section', () => ctx.slots.register(
          { name: 'settings.section', id: 'douyin-all', order: 31, label: '刷抖音' },
          Panel,
        ));
      },
    };
  },
});

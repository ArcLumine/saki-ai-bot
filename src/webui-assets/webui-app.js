const $ = (id) => document.getElementById(id);
// ── 深色模式（第十六版，2026-09-17 加，用户要求「增加黑暗模式」）──
//    存在 localStorage，刷新/关了页面都记得住。
//    ⚠️ 主题只给 <body> 挂一个 class，**所有配色都在 CSS 的 `body.dark` 块里**，
//       JS 不掺和具体颜色 —— 免得两处各写一套、改一处忘一处。
const THEME_KEY = 'saki-theme';
function applyTheme(dark) {
  document.body.classList.toggle('dark', !!dark);
  const b = document.getElementById('themeBtn');
  if (b) b.textContent = dark ? '浅色' : '深色';
  // ⚠️ 2026-09-17：切完主题要让**高光**重算一次 ——
  //    深色和浅色用的白色强度不一样（见 updateGlare 里的 `darkNow`），
  //    而高光只在鼠标移动时刷新；切主题时鼠标通常正停着不动。
  try {
    window.dispatchEvent(new Event('saki-theme'));
  } catch { /* 老浏览器不支持就算了，鼠标一动照样会重算 */ }
}
function toggleTheme() {
  const dark = !document.body.classList.contains('dark');
  try { localStorage.setItem(THEME_KEY, dark ? 'dark' : 'light'); } catch { /* 无痕模式就别记了 */ }
  applyTheme(dark);
}
applyTheme((() => { try { return localStorage.getItem(THEME_KEY) === 'dark'; } catch { return false; } })());

let STATE = null;

// ── 左侧栏的 Dock 放大（2026-09-17 用户要求「macOS dock 那种悬停自动放大」）──
//
// ⚠️ 关键不是"悬停那个放大"，而是**邻近的也按距离衰减地放大** ——
//    只有这样才像一整排东西被光标"抬"起来，而不是一个一个单独跳。
//    所以离光标的距离要参与计算（平方衰减：近的涨得快、远的掉得快）。
//
// ⚠️⚠️ 距离怎么算 —— **2026-09-25 改过一次，两条都读一遍再动**：
//
//  · 原来（拆卡片之前）用 `offsetTop / offsetHeight`，理由写在当时：
//    "`getBoundingClientRect` 拿到的值是**已经被上一次 transform 缩放过的**
//     → 用它会自我叠加、越抖越大；offsetTop 不受 transform 影响，缓存一次就够。"
//
//  · 2026-09-25 起改用 `getBoundingClientRect`，**原因是 offsetTop 不再够用**：
//    分组拆成各自一块卡片（`.navsec`）之后，浏览器把带 `backdrop-filter` 的元素
//    当包含块 ⇒ **每块卡片内部的 offsetTop 都从 0 重新开始** ⇒ 各组的项位置撞在一起
//    ⇒ 光标移到一处、三组一起放大（用户报的就是这个）✗
//
//  · 那"自我叠加"怎么办？——**已经挡住了**，靠下面两条，别删：
//    ① `collect()` 第一行**先把所有 transform 清掉**再量 ⇒ 量到的必然是未缩放的位置；
//    ② `items` 是**缓存**的，只在 `childList` 变（切页签重画）和 `resize` 时重量
//       ⇒ 不会在 mousemove 里反复重量、也就不会把缩放结果喂回自己。
(() => {
  const nav = document.querySelector('nav');
  if (!nav) return;
  const RANGE = 110; // 光标上下多大范围内会受影响（px）
  // ⚠️ 2026-09-17 用户纠正过两次，结论是「**等比缩放**、但要明显」：
  //    第一版 `scale(x,y)` 横竖不同 → **字体被拉变形**（他明确说"长宽比例不能变"）；
  //    第二版横向只给 6% → 他嫌"左右缩放太不明显"。
  //    最终：**等比 16%**，同时靠 CSS 里那个 `margin-right:24px` 留出横向余量 ——
  //    按钮平时窄 24px，放大 1.16 倍刚好填满侧栏，既不溢出、又看得出来。
  const MAX = 0.16; // 离光标最近的那一项放大 16%（等比）
  let items = [];

  function collect() {
    // 先清掉 transform 再量，免得量到缩放后的位置（虽然 offset* 不受影响，但求稳）
    for (const b of nav.querySelectorAll('button')) b.style.transform = '';
    // ⚠️⚠️ 2026-09-25 修（用户报「光标附近字体放大，三组会一起放大」）：
    //    原来用 `b.offsetTop` 量位置 —— 那是**相对 offsetParent** 的。
    //    侧栏还是一条 `nav` 的时候所有按钮同一个坐标系，没问题；
    //    2026-09-25 把分组拆成**各自一块卡片**（`.navsec` 带 `backdrop-filter`，
    //    浏览器会把这种元素当包含块）⇒ **每组内部的 offsetTop 都从 0 重新开始**
    //    ⇒ 三组的第一项位置撞在一起 ⇒ 一起放大 ✗
    //    ⇒ 改用 `getBoundingClientRect()` 算**相对 nav 的绝对中心**，跟 `update()` 里
    //      那个 `y` 用同一套坐标系，就跟卡片怎么拆无关了。
    //    ⚠️ 必须先清掉 transform 再量（不然量到的是放大后的位置）—— 上面那行已经清了。
    const navTop = nav.getBoundingClientRect().top;
    items = [...nav.querySelectorAll('button')].map((b) => {
      const r = b.getBoundingClientRect();
      // ⚠️ `sec` = 这个按钮属于哪块卡片。拆卡片之后**必须**带上它：
      //    放大范围 `RANGE`(110px) 比卡片间距(14px)大得多，不加限制就会
      //    跨到隔壁组去 ⇒ 又变成"多组一起放大" ✗
      return { b, sec: b.closest('.navsec'), cy: r.top - navTop + r.height / 2 };
    });
  }

  function update(clientY, curSec) {
    if (!items.length) collect();
    const y = clientY - nav.getBoundingClientRect().top; // 换算成"相对侧栏"的 y
    for (const it of items) {
      // ⚠️⚠️ 2026-09-25：**只在鼠标所在的那块卡片里**放大。
      //    拆卡片之前整条侧栏是一列，`RANGE` 跨组无所谓；现在跨组就等于
      //    "三组一起放大"（用户报的正是这个）✗
      if (curSec && it.sec !== curSec) { it.b.style.transform = ''; continue; }
      const d = Math.abs(y - it.cy);
      const t = Math.max(0, 1 - d / RANGE);
      const k = t * t; // 平方衰减：近的涨得快、远的掉得快
      const s = 1 + MAX * k; // ⚠️ **等比**：两个方向同一个倍数，文字才不会变形
      it.b.style.transform = k > 0.002 ? `scale(${s.toFixed(3)})` : '';
    }
  }

  function reset() {
    for (const it of items) it.b.style.transform = '';
  }

  // ⚠️ 把「鼠标在哪块卡片里」一起传进去（closest 对 padding 区里的鼠标也有效）
  nav.addEventListener('mousemove', (e) => update(e.clientY, e.target.closest && e.target.closest('.navsec')), { passive: true });
  nav.addEventListener('mouseleave', reset, { passive: true });
  // 切页签时按钮会被重画 → 重新量一次
  new MutationObserver(() => collect()).observe(nav, { childList: true });
  // ⚠️ 2026-09-25 加：窗口缩放 / 字体变化都会让按钮位置变，
  //    而 `items` 是**缓存**的 ⇒ 不重量就会拿旧坐标去放大（表现为"放大错的那一项"）。
  addEventListener('resize', () => collect(), { passive: true });
})();

// ── 背景油滴（2026-09-17 第四版；用户连着纠正了三次）──
//
//   用户要的效果：「一堆小色坨像浮在水上的油滴，互不相溶；
//                  鼠标穿过把它们撑散、甚至会裂开，过一会儿又自己合回一起」
//
// ⚠️⚠️ 前三版全错在同一个地方，记下来别再犯：
//   ① 第一版：给一块大背景渐变做 animation —— 位移太小 + 叠了 blur，**肉眼看是静态的**；
//   ② 第二版：加大位移幅度 —— 仍然只是"渐变在动"，不是油滴；
//   ③ 第三版：换成真实元素 + **弹簧拉回原位** —— 用户一句话点破：
//      「像装了橡皮筋固定在一个点，被挤开又完全回到原位」。
//      **油滴不该有"家"** —— 它就该自由漂着，被打散后在别处重新聚起来。
//
// 所以这一版只有三种力，**没有任何"回原位"**：
//   ① 油滴之间：重叠 → 强排斥（不许穿模）；挨得近 → 弱吸引（表面张力，自己聚成团）
//   ② 鼠标：近距离强排斥（撑散）
//   ③ 阻尼 + 边界软反弹（不让它们飘出屏幕再也回不来）
// 外加两条让效果真正立起来的东西：
//   · **分裂**：被鼠标推得太狠的大油滴会裂成两个 —— 这才叫「撑散裂开」
//   · **合并**：两个油滴挨得足够近会并成一个 —— 这就是「过一会儿自己合回一起」
//
// ⚠️ 性能红线（改之前先想清楚）：
//   ① 只改 `transform`（GPU 合成），**绝不改 `background`** —— 那会触发重绘，20+ 个必卡；
//   ② 不给油滴加 CSS `transition` —— 位置是逐帧算的，加过渡只会和物理打架；
//   ③ 两两计算是 O(n²)，所以数量上限卡在 44（44²/2 ≈ 968 次/帧，安全）。
//
// ⚠️ 坐标约定：`x/y` 是**圆心**（不是左上角），所以 translate 时要 `- r`。
//    上一版就是这里搞混过，排斥力算歪了半个油滴。
(() => {
  const host = document.getElementById('bgfx');
  if (!host) return;

  // ⚠️ 2026-09-17：蓝白为主（用户原话「背景是蓝白动态渐变」）—— 6 色里只留 1 个紫，
  //   原来 4 色占 1/4 的紫，画面偏"紫气"，跟"蓝白"不符。
  const COLORS = ['0,114,245', '1,207,234', '56,132,255', '120,180,255', '0,150,255', '178,73,248'];
  // ── 手感就调这几个 ──
  const N0 = 26;          // 初始油滴数（2026-09-17：数量加回来，尺寸相应降一点免得挤）
  const MAXN = 44;        // 上限（分裂出来的不会无限涨）
  // ⚠️ 2026-09-17 用户报「离鼠标色坨很远就被弹走了，要减小鼠标色坨的碰撞体积」——
  //    300 太大：油滴还没贴上就被推开，看着像有层看不见的气墙。
  //    收到 135（≈ 鼠标半径 44 + 油滴半径 的接触距离），挨近了才有感觉。
  const R_MOUSE = 135;    // 鼠标影响半径
  // ⚠️ F_MOUSE 从 4.2 降到 2.4 —— 4.2 会把油滴**直接击飞**（用户报「被击飞后再也回不来」）。
  //    「撑散」靠的是**挤**，不是"打飞"。
  const F_MOUSE = 2.4;
  const F_REPEL = 4.4;    // 油滴互相排斥（不许重叠）
  const F_TENS = 0.0012;  // 表面张力（弱吸引 → 自己聚成团）
  const TENS_RANGE = 95;  // 张力作用范围（超出就不吸了，免得全糊成一坨）
  // ── 回填：鼠标一挥中间空了，得让油滴**慢慢、随机地**飘回来重新摊匀 ──
  //    用户原话：「背景色坨其实还是得往回走，要不然鼠标一挥中间就空了，
  //    但是要往回走得随机，走完之后色坨要平均的摊在背景上」。
  //    ⚠️ 这跟被否掉的"回原位"不是一回事：目标位**每隔十几秒整体洗牌**，
  //    每滴还带各自的"懒散系数"，所以回来的先后、快慢都不同 —— 不是列队归位。
  const F_HOME = 0.00022; // 回位力（必须远小于 F_MOUSE 的 2.4，否则推不动）
  const HOME_JIT = 46;    // 目标位自身的抖动半径（摊匀，但不成网格）
  const DAMP = 0.93;      // 阻尼（留惯性，像液体）
  // ⚠️⚠️ 分裂阈值原来是 52，可初始半径只有 22~56 —— **大部分油滴永远够不着**，
  //      所以用户看到的现象是「怎么都挤不烂」。降到 26 才真的会裂。
  const SPLIT_AT = 26;
  const MERGE_AT = 0.78;  // 圆心距 < (r1+r2)*0.78 → 合并
  const SPLIT_PUSH = 1.2; // 推到这个力度就裂（原来 2.0 太高）
  const MIN_R = 16;       // 裂出来的不能比这更小（否则越裂越多、糊成一片）
  // ── 墙（用户要求「加一个比窗口略大的墙」）──
  const PAD = 0.18;       // 墙比窗口大 18%
  const WALL_DAMP = 0.25; // 撞墙后保留多少速度（原来 0.5 太弹，会来回撞着往外跑）
  const F_VIEW = 0.055;   // 飘出可见区时的回拉（⚠️ 不是"回原位"，只是别飘丢）
  const W = () => innerWidth, H = () => innerHeight;

  const blobs = [];
  let seq = 0;

  function make(x, y, r, vx = 0, vy = 0) {
    const el = document.createElement('div');
    el.className = 'blob';
    const c = COLORS[seq++ % COLORS.length];
    el.style.width = el.style.height = (r * 2).toFixed(0) + 'px';
    el.style.background =
      `radial-gradient(circle at 40% 38%, rgba(${c},.95), rgba(${c},.32) 60%, rgba(${c},0) 72%)`;
    host.appendChild(el);
    // hx/hy = 回填的目标位（先放在原地，随后 reshuffle 统一铺开）
    // lazy  = 每滴的"懒散系数" → 回位速度各不相同，看着才随机
    return { el, x, y, vx, vy, r, cool: 0, hx: x, hy: y, lazy: 0.55 + Math.random() * 0.9 };
  }

  for (let i = 0; i < N0; i++) {
    // ⚠️ 2026-09-17 用户要求「尺寸调回来，大的更容易被挤破」—— 对的，两个原因：
    //    ① 目标大 → 更容易被鼠标碰到；
    //    ② pushed 的公式是 `(1 - d/(R_MOUSE + b.r)) * F_MOUSE`，**b.r 越大值越大**，
    //       所以大油滴天然被推得更狠 → 更容易过 SPLIT_PUSH 那道坎。
    //    半径 34~80（直径 68~160px），接近第一版的观感。
    blobs.push(make(Math.random() * W(), Math.random() * H(), 28 + Math.random() * 38,
      (Math.random() - .5) * .5, (Math.random() - .5) * .5));
  }

  // 鼠标自己也是一个油滴（紫色那个）—— 撑散别人的就是它
  // ⚠️ 62 → 44：用户要「减小鼠标色坨的碰撞体积」，视觉上小一号也更贴手
  const MR = 44;
  const mEl = document.createElement('div');
  mEl.className = 'blob m';
  mEl.style.width = mEl.style.height = MR * 2 + 'px';
  mEl.style.background =
    'radial-gradient(circle at 42% 40%, rgba(128,90,255,.9), rgba(128,90,255,.28) 58%, rgba(128,90,255,0) 72%)';
  host.appendChild(mEl);

  let mx = W() / 2, my = H() / 2, tx = mx, ty = my;
  let lastMove = performance.now();
  addEventListener('mousemove', (e) => {
    tx = e.clientX; ty = e.clientY; lastMove = performance.now();
  }, { passive: true });

  // ── 回填目标位：低差异序列（R2）能"均匀铺满"矩形，比纯随机更平摊、又不像网格那么死板 ──
  function idealAt(rank) {
    const g = 0.7548776662466927, a = 0.5698402909980532;
    return { x: ((rank * g) % 1) * W(), y: ((rank * a) % 1) * H() };
  }
  let shuffleTimer = 0;
  function reshuffle() {
    // 洗牌 → 同一滴油每次拿到的目标位都不同，这就是"回得随机"的来源
    const idx = blobs.map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = (Math.random() * (i + 1)) | 0;
      const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
    }
    idx.forEach((bi, rank) => {
      const p = idealAt(rank + 0.5), b = blobs[bi];
      if (!b) return;
      b.hx = p.x + (Math.random() - .5) * HOME_JIT * 2;
      b.hy = p.y + (Math.random() - .5) * HOME_JIT * 2;
    });
    shuffleTimer = 420 + ((Math.random() * 420) | 0);   // 7~14 秒后自动再洗一次
  }
  reshuffle();
  addEventListener('resize', reshuffle);

  let mAct = 1;   // 鼠标"还在动"的程度：手停住 1.2 秒后渐隐到 0

  // ── 玻璃高光：只有**面朝鼠标的那一侧边缘**亮 ──
  //    用户原话：「给玻璃加上高光，只有面朝鼠标的一侧边缘有高光」。
  //    做法把鼠标当光源：从卡片中心朝鼠标画一条线，与边框的交点就是高光中心。
  //      ① 把鼠标换算成"相对卡片中心的归一化坐标" (ux,uy)：右下为正，边上的值是 ±1；
  //      ② 除以 max(|ux|,|uy|) 就是把这条线推**到边框上**（这一步是关键，不然高光会飘在卡片里）；
  //      ③ 鼠标越靠近卡片中心，方向越没意义 → 用 a 把强度收到 0，免得高光乱跳。
  //    ⚠️ 整条渐变都在 JS 里拼好（含透明度），CSS 只负责 `var(--glare,none)` ——
  //       CSS 里不出现任何 calc / 变量算式，避免"表达式非法 → 整条 background 作废"。
  let glarePending = false;
  function updateGlare() {
    glarePending = false;
    for (const el of document.querySelectorAll('.card, nav')) {
      const r = el.getBoundingClientRect();
      if (!r.width || r.bottom < -120 || r.top > innerHeight + 120) continue;  // 看不见的跳过
      const ux = (tx - (r.left + r.width / 2)) / (r.width / 2);
      const uy = (ty - (r.top + r.height / 2)) / (r.height / 2);
      // （② 那步"把点推到边框上"是径向渐变时代算的 gx/gy，换成线性渐变后不再需要）
      // ⚠️⚠️ 第十五版：改用**线性渐变**（前面几版都是径向渐变，做错了对象）。
      //    径向渐变的圆心在边框上、半径向内铺开 → 看起来是"卡片里一块暗/一块亮"，
      //    边框本身反而没变化（用户原话「边框好像没变化，但是色坨被压暗了」）。
      //    线性渐变沿**鼠标轴**走：一端落在背光那条边上（压黑），
      //    另一端落在面朝鼠标那条边上（纯白）—— 两端极值正好压在边框上，
      //    所以变化发生在**边框**，这才是玻璃受光该有的样子。
      // ── 强度 = 方向 × 距离衰减（第二十版）──
      //    ⚠️ 用户要求「高光应该要随距离衰减」。原来那句 `Math.min(1, hypot*0.8)`
      //       **只看方向**：鼠标一离开卡片中心就迅速饱和到满强度，
      //       所以贴着卡片和隔半个屏幕，亮带一样亮 —— 看着假。
      //    现在分成两个因子：
      //      ① dir  —— 方向强度：卡片正中 0、边缘 1（正中心方向没有意义，收 0）；
      //      ② fall —— **鼠标到卡片矩形的像素距离**上的衰减（1.5 次方，比线性略陡，
      //                接近真实光照的感觉；380px 处约剩一半）。
      const dir = Math.min(1, Math.hypot(ux, uy));
      const ddx = Math.max(r.left - tx, 0, tx - r.right);
      const ddy = Math.max(r.top - ty, 0, ty - r.bottom);
      const fall = 1 / (1 + Math.pow(Math.hypot(ddx, ddy) / 380, 1.5));
      // ⚠️⚠️ 2026-09-17：深色的高光强度定在 **0.62**，这个数是两次反馈磨出来的：
      //    · 用户先说「夜间模式的高光可以薄一点，晚上有点晃眼睛」→ 我从 0.98 收到 0.5；
      //    · 结果用户又截图报「高光在中间，鼠标在右边」—— 因为 0.5 太弱，
      //      **输给了卡片背景那道固定亮部**（它不是跟随鼠标的，见 CSS 里那段注释）。
      //    所以两头一起改：**背景压平 + 这里回到 0.62**。
      //    浅色保持 0.98 不动 —— 那个"拉满"是用户明确要过的。
      const darkNow = document.body.classList.contains('dark');
      const a = (darkNow ? 0.62 : 0.98) * dir * fall;
      // CSS 渐变角度：0deg 指向正上方，而屏幕 y 向下 → θ = atan2(dx, -dy)
      // ⚠️⚠️ 2026-09-17：`conic-gradient` → **`radial-gradient`**。
      //    这是用户那句「红圈里的高光比鼠标旁更亮」的**真正病根**，
      //    前后换过三版（径向 → 四层 mask → 线性 → conic → 椭圆 mask）才定位到：
      //
      //    `conic-gradient` 是按**角度**均匀的，而**角上的一小段角度只对应
      //    很短的一段边缘** → 同样的亮度压在一个角上，看起来就比铺在长边上的亮。
      //    （边上同样的角度范围要铺几百像素，角上只铺几十像素 → 浓度差好几倍。）
      //
      //    `radial-gradient` 按**到圆心的实际距离**衰减，沿边缘是均匀的 →
      //    角上离圆心远，会自然淡下去。圆心取"**边框上正对鼠标的那个点**"，
      //    所以最亮的永远是朝鼠标那一侧。
      //
      //    ⚠️ 圆心在边框上、半径 300px，本来会铺进卡片内部（那是早期径向版被否的原因）；
      //       现在外面有 mask 兜着（只保留边缘 34px），所以这个老毛病不存在了。
      const kk = 1 / Math.max(Math.abs(ux), Math.abs(uy), 1e-4); // 把这条线推到边框上
      const gx = (50 + ux * kk * 50).toFixed(1);
      const gy = (50 + uy * kk * 50).toFixed(1);
      const str = a < 0.02 ? 'none'
        : `radial-gradient(circle 300px at ${gx}% ${gy}%,`
          + `rgba(255,255,255,${a.toFixed(3)}) 0%,`                       // 正对鼠标那一点
          + `rgba(255,255,255,${(a * .42).toFixed(3)}) 26%,`
          + `rgba(255,255,255,${(a * .12).toFixed(3)}) 52%,`
          + `rgba(255,255,255,0) 76%)`;
      if (el._glare !== str) { el._glare = str; el.style.setProperty('--glare', str); }
    }
  }
  const askGlare = () => {
    if (!glarePending) { glarePending = true; requestAnimationFrame(updateGlare); }
  };
  addEventListener('mousemove', askGlare, { passive: true });
  addEventListener('scroll', askGlare, { passive: true, capture: true });  // 滚动后方位会变
  // ⚠️ 2026-09-17：**切主题时也要重算** —— 深色下高光的白色强度是另一套
  //    （见上面 `darkNow` 那行）。高光只在鼠标移动时刷新，而切主题时鼠标往往
  //    正停在按钮上不动 → 会一直挂着上一个主题的亮度。
  //    用自定义事件解耦：`applyTheme()` 派发，这里监听（两边不用互相 import）。
  addEventListener('saki-theme', askGlare);
  askGlare();   // 先按初始位置算一次（鼠标还没动过时也不至于完全没有高光）

  (function tick() {
    mx += (tx - mx) * 0.16;   // 鼠标油滴带点延迟跟随：直接跟手像光标，加惯性才像液体
    my += (ty - my) * 0.16;
    if (--shuffleTimer <= 0) reshuffle();

    // ⚠️ 鼠标停住之后必须把力撤掉 —— 否则它会一直"顶"在原地，
    //    那片空区就永远回填不了（用户报的「鼠标一挥中间就空了」，有一半是这个原因）。
    const idle = performance.now() - lastMove;
    mAct += ((idle < 1200 ? 1 : 0) - mAct) * 0.035;
    mEl.style.opacity = (mAct * 0.62).toFixed(3);
    mEl.style.transform = `translate3d(${(mx - MR).toFixed(1)}px,${(my - MR).toFixed(1)}px,0)`;

    // ── ① 油滴之间：重叠就推开，挨得近就吸住 ──
    for (let i = 0; i < blobs.length; i++) {
      const a = blobs[i];
      for (let j = i + 1; j < blobs.length; j++) {
        const b = blobs[j];
        let dx = b.x - a.x, dy = b.y - a.y;
        let d = Math.hypot(dx, dy);
        if (d < 0.01) { dx = Math.random() - .5; dy = Math.random() - .5; d = 0.01; }
        const sum = a.r + b.r;
        const ux = dx / d, uy = dy / d;
        if (d < sum) {
          // 重叠 → 强排斥；按半径分摊（大的更"沉"、推得少）
          const f = ((sum - d) / sum) * F_REPEL;
          const ma = b.r / sum, mb = a.r / sum;
          a.vx -= ux * f * ma; a.vy -= uy * f * ma;
          b.vx += ux * f * mb; b.vy += uy * f * mb;
        } else if (d < sum + TENS_RANGE) {
          // 表面张力：挨得近就互相吸 → 自己聚成团（互不相溶的油滴就是这样抱团的）
          const f = F_TENS * (1 - (d - sum) / TENS_RANGE);
          a.vx += ux * f; a.vy += uy * f;
          b.vx -= ux * f; b.vy -= uy * f;
        }
      }
    }

    // ── ② 鼠标排斥 + ③ 阻尼/边界/分裂 ──
    const born = [];
    for (const b of blobs) {
      if (b.cool > 0) b.cool--;
      const dx = b.x - mx, dy = b.y - my;
      const d = Math.hypot(dx, dy) || 1;
      let pushed = 0;
      if (d < R_MOUSE + b.r && mAct > 0.01) {
        pushed = (1 - d / (R_MOUSE + b.r)) * F_MOUSE * mAct;
        b.vx += (dx / d) * pushed;
        b.vy += (dy / d) * pushed;
      }
      // ── 回填：鼠标影响范围之外，朝"摊匀位"缓缓漂回去 ──
      //    ⚠️ 只在鼠标范围外施加，否则会和推挤打架（手感发黏、像被吸住）
      if (pushed === 0) {
        b.vx += (b.hx - b.x) * F_HOME * b.lazy;
        b.vy += (b.hy - b.y) * F_HOME * b.lazy;
      }
      b.vx *= DAMP; b.vy *= DAMP;
      b.x += b.vx; b.y += b.vy;
      // ── 墙：比窗口大 18%，撞上去速度砍到 1/4 ──
      //    ⚠️ 原来保留一半速度太弹：油滴会来回撞、越撞越往外，最后看不见。
      const wl = -W() * PAD, wr = W() * (1 + PAD), wt = -H() * PAD, wb = H() * (1 + PAD);
      if (b.x < wl) { b.x = wl; b.vx = Math.abs(b.vx) * WALL_DAMP; }
      if (b.x > wr) { b.x = wr; b.vx = -Math.abs(b.vx) * WALL_DAMP; }
      if (b.y < wt) { b.y = wt; b.vy = Math.abs(b.vy) * WALL_DAMP; }
      if (b.y > wb) { b.y = wb; b.vy = -Math.abs(b.vy) * WALL_DAMP; }

      // ── 视野回拉：已经飘到可见区外面了，轻轻拽回来一点 ──
      //    ⚠️⚠️ 这不是"回原位"（那个方案被用户否掉了：「像橡皮筋固定在一个点」）。
      //       它只干一件事：**保证你还能看见它**。力很小，而且只作用在
      //       「超出可见圆」的那部分位移上 —— 留在屏幕里的油滴完全没感觉。
      const ox = b.x - W() / 2, oy = b.y - H() / 2;
      const od = Math.hypot(ox, oy) || 1;
      const lim = Math.min(W(), H()) * 0.62;
      if (od > lim) {
        const pull = F_VIEW * ((od - lim) / lim);
        b.vx -= (ox / od) * pull;
        b.vy -= (oy / od) * pull;
      }

      // 分裂：够大 + 被推得够狠 + 不在冷却里 → 一分为二（质量守恒）
      if (b.r > SPLIT_AT && pushed > SPLIT_PUSH && b.cool === 0 &&
          b.r / Math.cbrt(2) > MIN_R &&
          blobs.length + born.length < MAXN) {
        const nr = b.r / Math.cbrt(2);
        b.r = nr;
        b.el.style.width = b.el.style.height = (nr * 2).toFixed(0) + 'px';
        b.cool = 90; // 约 1.5 秒（60fps）内不再裂，免得一次推出一堆
        const ang = Math.atan2(dy, dx) + Math.PI / 2;
        born.push(make(b.x + Math.cos(ang) * nr * 1.2, b.y + Math.sin(ang) * nr * 1.2,
          nr, Math.cos(ang) * 1.8, Math.sin(ang) * 1.8));
      }
      b.el.style.transform =
        `translate3d(${(b.x - b.r).toFixed(1)}px,${(b.y - b.r).toFixed(1)}px,0)`;
    }
    if (born.length) blobs.push(...born);

    // ── ④ 合并：挨得足够近就并回一个（「过一会儿自己合回一起」）──
    for (let i = 0; i < blobs.length; i++) {
      for (let j = i + 1; j < blobs.length; j++) {
        const a = blobs[i], b = blobs[j];
        if (Math.hypot(b.x - a.x, b.y - a.y) < (a.r + b.r) * MERGE_AT) {
          const va = a.r ** 3, vb = b.r ** 3, vt = va + vb;
          const big = a.r >= b.r ? a : b;
          const small = big === a ? b : a;
          big.x = (a.x * va + b.x * vb) / vt;   // 质心
          big.y = (a.y * va + b.y * vb) / vt;
          big.vx = (a.vx * va + b.vx * vb) / vt;
          big.vy = (a.vy * va + b.vy * vb) / vt;
          big.r = Math.cbrt(vt);               // 体积守恒
          big.el.style.width = big.el.style.height = (big.r * 2).toFixed(0) + 'px';
          small.el.remove();
          blobs.splice(blobs.indexOf(small), 1);
          j--;
        }
      }
    }

    requestAnimationFrame(tick);
  })();
})();


// ── 多 QQ 号：现在控制哪个号（2026-10-07 加）──────────────────────
//
// 用户原话：「我希望从一个应用端控制多个 QQ 号……基础卡片新增一个切换正在控制的
// QQ 的页面，只有模型页面所有 QQ 共用，其他配置全部分 QQ 控制」。
//
// 实现上：一个号一个 `node src/index.js` 进程（各自一套状态），
// 每个进程开自己的管理界面端口；**这个页面只连着一个进程**，
// 切号 = 之后的每个请求都带 `x-saki-account: <QQ>`，
// 服务端看到"不是我"就转发给那个号的进程（见 webui.js 的 `proxyToAccount`）。
// ⇒ 所有既有接口一行都不用改，它们在那个进程里读写自己的数据。
let CUR_ACCOUNT = localStorage.getItem('saki-account') || '';
let ACC_LIST = [];
let ACC_SELF = { qq: '', main: '', isMain: true, port: 3099 };

async function api(path, opts) {
  const o = { ...(opts || {}) };
  // ⚠️ 这两个接口是"管所有号"的：`/api/accounts`（列表/增删/复制）
  //    和 `/api/whoami`（问"我连着的这个进程是谁"）——
  //    它们**绝不能**跟着当前号转发，否则"问自己是谁"会问到别人头上。
  if (CUR_ACCOUNT && !/^\/api\/(accounts|whoami|pools)\b/.test(path)) {
    o.headers = { ...(o.headers || {}), 'x-saki-account': CUR_ACCOUNT };
  }
  const r = await fetch(path, o);
  return r.json();
}

/** 显示成「备注（QQ）」；没写备注就只显示 QQ */
function accName(a) {
  const n = String(a?.name ?? '').trim();
  return n ? `${n}（${a.qq}）` : String(a?.qq ?? '');
}

/** 侧栏那个按钮上挂出"现在控制谁" —— 切完号最容易忘的就是这件事 */
function accPaintNav() {
  const b = $('nav-accounts');
  if (!b) return;
  const hit = ACC_LIST.find((a) => a.qq === CUR_ACCOUNT);
  const label = hit ? (hit.name || hit.qq) : CUR_ACCOUNT;
  b.textContent = label ? `QQ 号 · ${label}` : 'QQ 号';
}

/** 页面一打开问一句"我连着的这个进程是哪个号"，没记录过就默认它 */
async function initAccounts() {
  try {
    const w = await api('/api/whoami');
    if (w && w.ok) {
      ACC_SELF = w;
      if (!CUR_ACCOUNT) CUR_ACCOUNT = w.qq || '';
    }
  } catch {}
  accPaintNav();
}

/**
 * ⚠️ 2026-10-14 加：**私聊工作模式**（一号一份、默认关）——
 * 打开后这个号的好友私聊按"接单"走（先摸需求 → 问要不要开始 → 到点交付）。
 * 后端 `POST /api/config` → `splitPatch()`：`privateWork` 不在共用段里 ⇒
 * 自动写进 `accounts/<QQ>.yml`（只有这个号变）✓
 */
// ⚠️ 2026-10-14：工作模式那一页的读取（两个开关的状态走 /api/accounts，和 QQ 号页同一份）
async function renderWorkMode() {
  await renderAccounts();
  // ⚠️⚠️ 2026-10-19 加（用户第三次报那两个开关）：那两个「当前：…」原来只靠
  //    `renderAccounts()` 顺带刷 —— 那一整套里任何一步抛异常就停在旧值 ⇒ 界面撒谎 ✗
  //    ⇒ 进这个页面时**再单独问一次**那个轻接口（只读内存、不探活），拿到啥就显示啥 ✓
  try {
    const sw0 = await api('/api/switches').catch(() => null);
    if (sw0 && sw0.ok) accShowSwitchState(sw0);
  } catch {}
  const r = await api("/api/config").catch(() => null);
  const cfg = (r && (r.config || r)) || {};
  const w = cfg.privateWork || {};
  const set = (id, v) => { const el = $(id); if (el && v !== undefined && v !== null) el.value = v; };
  set("pw-timeout", Math.round((Number(w.agentTimeoutMs) || 900000) / 60000));
  set("pw-etamin", w.etaMinMin === undefined ? 8 : w.etaMinMin);
  set("pw-etamax", w.etaMaxMin === undefined ? 240 : w.etaMaxMin);
  set("pw-jitter", w.etaJitter === undefined ? 0.25 : w.etaJitter);
  set("pw-inmb", w.maxIncomingMB === undefined ? 50 : w.maxIncomingMB);
  set("pw-outmb", w.maxSendMB === undefined ? 30 : w.maxSendMB);
  set("pw-direct", w.maxFilesDirect === undefined ? 3 : w.maxFilesDirect);
  set("pw-daily", w.dailyMax === undefined ? 5 : w.dailyMax);
  set("pw-maxconc", w.maxConcurrent === undefined ? 5 : w.maxConcurrent);
  set("pw-refresh", Math.round((Number(w.friendRefreshMs) || 600000) / 60000));
  // ⚠️ 分好友那张表（好友名单来自协议端，各人的设置来自这个号的 privateWork.friends）
  const box = $("pw-friends");
  if (box) {
    const d = await api("/api/private-work").catch(() => null);
    if (!d || !d.ok) box.innerHTML = "<span class=\"hint\">读不到好友名单（服务端出错了）</span>";
    else if (d.off) box.innerHTML = "<span class=\"hint\">这个号还没开「私聊工作模式」—— 开了之后这里会列出它的好友。</span>";
    else if (!d.friends.length) box.innerHTML = "<span class=\"hint\">好友名单还是空的（协议端刚起来，等十分钟它自己刷一次）。</span>";
    else {
      box.innerHTML = pwFriendTable(d);
      // ⚠️ 2026-10-15：表刚重建 ⇒ 把搜索框里的条件**再套一次**（不然一刷新就又全列出来了）✓
      filterPwFriends();
    }
  }
  const root = $("pw-root");
  if (root) root.textContent = String(w.rootDir || "（默认：%LOCALAPPDATA%\\DeepSeekHarness\\private-work）");
}

/** ⚠️ 分好友那张表（列宽用行内样式，不去动全局 CSS） */
function pwFriendTable(d) {
  const STAGE = { intake: "在聊需求", confirming: "等他点头", running: "在做", waiting: "等交付", done: "上一个完了", sendfail: "没发出去，等他催" };
  // ⚠️ 2026-10-16 加（用户：「好友排序改成**按最近对话时间**排，有新对话的排在上面」）✓
  const sorted = d.friends.slice().sort((a, b) => (Number(b.talkAt) || 0) - (Number(a.talkAt) || 0));
  const rows = sorted.map((f) => {
    const c = f.cfg || {};
    const q = esc(f.qq);
    const st = STAGE[f.stage] || "";
    // ⚠️⚠️ 2026-10-16 加（用户：「工作模式分好友界面加**工作进度**：对话状态、任务完成状态、
    //    还有多久自动发送产物，再加一个**手动立刻发送产物**按钮」）——
    //    · 倒计时写成 `data-eta`，交给 `pwTickEta()` **每秒本地刷**（不重拉接口 ⇒ 表不闪）✓
    //    · 有产物、并且这条活已经做到"等交付 / 交付过 / 发失败"⇒ 给一个「立刻发送产物」按钮 ✓
    const arts = Array.isArray(f.arts) ? f.arts : [];
    // ⚠️⚠️ 2026-10-16 用户报的：「**没看到立即发送的按钮**」——
    //    原来只有"等交付 / 交付过 / 发失败"才给按，可 `stage` 常常已经回到 `intake`
    //    （客户又开始聊下一件了）⇒ 产物明明在、按钮却不见了 ✗
    //    ⇒ 改成：**只要有产物就给按**（他要手动发就发，不设门槛）✓
    const canSend = arts.length > 0;
    const busy = f.busy === true;
    return "<tr style=\"border-top:1px solid #333\">"
      + "<td style=\"padding:12px 8px;vertical-align:top\"><b>" + esc(f.name || f.qq) + "</b>"
      + "<div class=\"hint mono\">" + q + "</div>"
      // ⚠️ 2026-10-16 用户：「**有点乱了 ⇒ 加一下分割线**」——
      //    名字 / QQ 归上面，进度那几行用**一条虚线**隔开（一眼分清"人"和"进度"）✓
      + "<div style=\"margin-top:6px;padding-top:6px;border-top:1px dashed #3a3a4a\">"
      + (st || busy ? "<div class=\"hint\">" + (busy ? "🔧 " : "") + esc(st || "") + "</div>" : "")
      // ⚠️ 2026-10-16：「最近对话时间」——一眼看出谁刚说过话（排序也是按它）✓
      + (f.talkAt ? "<div class=\"hint\">" + esc(pwAgo(f.talkAt)) + "</div>" : "")
      + (arts.length ? "<div class=\"hint\">产物（" + arts.length + "）：" + esc(arts.map((a) => a.name).join("、")) + "</div>" : "")
      // ⚠️ 2026-10-16 加（用户：「**在工作模式分好友设置那里再加个这个私聊一共花了多少钱的显示**」）
      + (f.costYuan
        ? "<div class=\"hint\">这个私聊一共花了 " + esc(pwYuan(f.costYuan)) + "（" + (f.costCalls || 0) + " 次调用）</div>"
        : "")
      // ⚠️⚠️⚠️ 2026-10-19 改（用户：「**要查看交付工具的状态，这个优先级高**」）——
      //    那几行原来全都挂在 `stage === 'waiting'` 上 ⇒ 而 stage 是**状态机**推的，
      //    跟"产物做没做出来"完全独立 ⇒ 活早干完了、产物有 16 个，
      //    stage 还停在 `intake`（界面上写"在聊需求"）⇒ **交付状态一行都不显示** ✗
      //    ⇒ 现在**只看实际的东西**（产物 / 发送记录 / 失败标记），不看 stage：
      + (function () {
          const n = arts.length;
          // ⚠️⚠️ 2026-10-20 改（用户：「这里的交付文件还是不对」）——
          //     `arts` 是 `产物/` 里**全部**文件（实测 17 个，其中 16 个是三天前的旧活）
          //     ⇒ 显示"这一轮"的数量（后端算好的 `thisRoundCount`）✓
          const mine = Number(f.thisRoundCount) || 0;
          const sent = Number(f.sentCount || 0);
          if (f.stage === "sendfail") {
            return "<div class=\"hint\" style=\"color:#e5484d\">⚠️ <b>交付失败</b>：上次一个都没发出去（等他催，或点下面那个）</div>";
          }
          if (sent > 0) {
            return (
              "<div class=\"hint\">✅ <b>已交付 " + sent + " 个</b>" +
              (f.sentAt ? "（" + new Date(f.sentAt).toLocaleString("zh-CN", { hour12: false }) + "）" : "") +
              "</div>"
            );
          }
          if (mine > 0) {
            return (
              "<div class=\"hint\">📦 <b>待交付</b>：" + mine + " 个产物已经做好了、<b>还没发给他</b>" +
              (n > mine
                ? "<span style=\"opacity:.6\">（产物目录里另有 " + (n - mine) + " 个是以前的，不发）</span>"
                : "") +
              "</div>"
            );
          }
          return "";
        })()
      // ⚠️ 去掉 `stage === "waiting"` 这个前提 —— 只要有"说好的时间"就显示倒计时 ✓
      + (f.etaAt ? "<div class=\"hint pw-eta\" data-eta=\"" + f.etaAt + "\">…</div>" : "")
      + (f.sentAt
        ? "<div class=\"hint\">已发 " + (f.sentCount || 0) + " 个（" + new Date(f.sentAt).toLocaleString("zh-CN", { hour12: false }) + "）</div>"
        : "")
      + (canSend
        ? "<div style=\"margin-top:6px\"><button class=\"act\" onclick=\"pwDeliverNow('" + q + "')\">立刻发送产物</button> <span class=\"hint\" id=\"pwf-msg-" + q + "\"></span></div>"
        : "")
      // ⚠️⚠️ 2026-10-19 加（用户：「**在工作模式的分好友设置那里加一个补回消息
      //    加补看文件的按钮**」）—— 每行一个，点它补**这个人**的：
      //    ① 消息（他这阵子说的话，补进她的上下文）② 文件（历史里有、工作区里没有的）
      //    ⚠️ 接管 / 掉线那阵子两样都会漏，所以做成**一个按钮做两件**（用户就这么说的）✓
      + "<div style=\"margin-top:6px\"><button class=\"ghost\" onclick=\"pwBackfillThis('" + q + "')\">补消息 + 补文件</button> <span class=\"hint\" id=\"pwbf-msg-" + q + "\"></span></div>"
      + "</div></td>"
      + "<td style=\"padding:6px 8px\"><input type=\"checkbox\" id=\"pwf-allow-" + q + "\"" + (c.allow === false ? "" : " checked") + "></td>"
      // ⚠️ 2026-10-15（用户：「分好友设置也加一个人工接管开关」）—— 勾上 = 这个人的私聊我自己回
      + "<td style=\"padding:6px 8px\"><input type=\"checkbox\" id=\"pwf-takeover-" + q + "\"" + (c.takeover === true ? " checked" : "") + "></td>"
      + "<td style=\"padding:6px 8px\"><input type=\"number\" id=\"pwf-timeout-" + q + "\" placeholder=\"" + d.defaults.timeoutMin + "\" value=\"" + (c.timeoutMin == null ? "" : c.timeoutMin) + "\" style=\"width:74px\"></td>"
      + "<td style=\"padding:6px 8px\"><input type=\"number\" id=\"pwf-etamin-" + q + "\" placeholder=\"" + d.defaults.etaMinMin + "\" value=\"" + (c.etaMinMin == null ? "" : c.etaMinMin) + "\" style=\"width:64px\"> ~ "
      + "<input type=\"number\" id=\"pwf-etamax-" + q + "\" placeholder=\"" + d.defaults.etaMaxMin + "\" value=\"" + (c.etaMaxMin == null ? "" : c.etaMaxMin) + "\" style=\"width:64px\"></td>"
      + "<td style=\"padding:6px 8px\"><input type=\"text\" id=\"pwf-note-" + q + "\" placeholder=\"（自己看的）\" value=\"" + esc(c.note || "") + "\" style=\"width:104px\"></td>"
      + "<td style=\"padding:6px 8px\"><button class=\"act\" onclick=\"saveFriendCfg('" + q + "')\">存</button></td>"
      + "</tr>";
  }).join("");
  return "<table style=\"width:100%;border-collapse:collapse\">"
    + "<thead><tr style=\"text-align:left\"><th style=\"padding:6px 8px\">好友</th><th style=\"padding:6px 8px\">允许派活</th>"
    + "<th style=\"padding:6px 8px\">人工接管</th>"
    + "<th style=\"padding:6px 8px\">单活上限(分)</th><th style=\"padding:6px 8px\">估时区间(分)</th>"
    + "<th style=\"padding:6px 8px\">备注</th><th></th></tr></thead><tbody>" + rows + "</tbody></table>"
    + "<p class=\"hint\">留空 = 跟着全局走（单活 " + d.defaults.timeoutMin + " 分 / 估时 " + d.defaults.etaMinMin + "~" + d.defaults.etaMaxMin + " 分 / 一天最多 " + d.defaults.dailyMax + " 单）。</p>";
}

/**
 * ⚠️ 2026-10-15 加（用户：「加个**搜索筛选框**来快捷找到要控制的好友卡片」）。
 * 纯前端过滤：按**昵称 / QQ 号 / 备注**匹配，命中的行留着、其余藏起来 ✓
 * ⚠️ 表是 `renderWorkMode()` 重建的，而搜索框本身不在表里（值会留着）——
 *    所以重建完要**再过滤一次**（见 `renderWorkMode` 里那一句）✓
 */
function filterPwFriends() {
  const el = $("pw-friend-search");
  const kw = String((el && el.value) || "").trim().toLowerCase();
  const box = $("pw-friends");
  if (!box) return;
  const rows = box.querySelectorAll("tbody tr");
  let shown = 0;
  rows.forEach((tr) => {
    const hit = !kw || String(tr.textContent || "").toLowerCase().includes(kw);
    tr.style.display = hit ? "" : "none";
    if (hit) shown++;
  });
  const tip = $("pw-friend-hint");
  if (tip) tip.textContent = kw ? `筛出 ${shown} / ${rows.length} 个好友` : "";
}

/** ⚠️ 2026-10-16 加：把"花了多少钱"写成人看的样子（小额要 4 位小数，不然显示成 0.00） */
function pwYuan(v) {
  const c = Number(v) || 0;
  if (c === 0) return "0 元";
  if (c < 0.0001) return "不到 0.0001 元";
  if (c < 0.1) return c.toFixed(4) + " 元";
  return c.toFixed(2) + " 元";
}

/** ⚠️ 2026-10-16 加：「多久之前」——好友表里显示、也是排序的直观依据 ✓ */
function pwAgo(t) {
  const d = Date.now() - Number(t || 0);
  if (!t || d < 0) return "";
  const m = Math.floor(d / 60000);
  if (m < 1) return "刚刚说过话";
  if (m < 60) return m + " 分钟前说过话";
  const h = Math.floor(m / 60);
  if (h < 24) return h + " 小时前说过话";
  return Math.floor(h / 24) + " 天前说过话";
}

/**
 * ⚠️⚠️ 2026-10-16 加（用户：「分好友界面加……**还有多久自动发送产物**」）——
 *    倒计时**每秒本地刷**（不重拉接口：表不会闪，也不会打断你正在填的输入框）✓
 */
function pwTickEta() {
  document.querySelectorAll(".pw-eta").forEach((el) => {
    const t = Number(el.getAttribute("data-eta") || 0);
    if (!t) return;
    const left = Math.round((t - Date.now()) / 1000);
    if (left <= 0) { el.textContent = "到点了，马上发"; return; }
    el.textContent = "还有 " + pwLeft(left) + "自动发送产物";
  });
}
/**
 * 剩余秒数 → 人话（天 / 小时 / 分钟 / 秒）。
 *
 * ⚠️⚠️ 2026-10-16 加（用户：「**一两个小时做完还显得太快了…估计时间还可以延长一点**」）——
 *    说好的时间拉长到 2 小时~2 天之后，原来那句「还有 1440 分钟自动发送产物」根本没法看 ✗
 */
function pwLeft(sec) {
  if (sec >= 86400) {
    const d = Math.floor(sec / 86400);
    const h = Math.round((sec % 86400) / 3600);
    return d + " 天" + (h ? " " + h + " 小时" : "") + " ";
  }
  if (sec >= 3600) {
    const h = Math.floor(sec / 3600);
    const m = Math.round((sec % 3600) / 60);
    return h + " 小时" + (m ? " " + m + " 分钟" : "") + " ";
  }
  if (sec >= 60) return Math.round(sec / 60) + " 分钟";
  return sec + " 秒";
}
setInterval(pwTickEta, 1000);

/**
 * ⚠️ 2026-10-16 加（用户：「**有新对话的排在上面**」）——
 *    表原来只在切页 / 点刷新时重建 ⇒ 新来的对话不会自己冒到顶上 ✗
 *    ⇒ 每 30 秒**悄悄重拉一次**（⚠️ 你正在表里填东西时跳过，别把输入框清空）✓
 */
setInterval(async () => {
  try {
    if (document.hidden) return;
    const box = $("pw-friends");
    if (!box || !box.querySelector("tbody")) return;
    if (document.activeElement && box.contains(document.activeElement)) return;
    const d = await api("/api/private-work").catch(() => null);
    if (!d || !d.ok || d.off || !d.friends || !d.friends.length) return;
    box.innerHTML = pwFriendTable(d);
    filterPwFriends();
  } catch {}
}, 30000);

/**
 * ⚠️ 2026-10-16 加（用户：「再加一个**手动立刻发送产物**按钮」）——
 *    走的就是服务端那个 `POST /api/private-work/deliver`（和"做完自动交付"**同一条路**）✓
 *    ⚠️ 一个文件都没发出去时**如实说**，别显示成成功 ✓
 */
async function pwDeliverNow(qq) {
  const msg = $("pwf-msg-" + qq);
  const say = (t) => { if (msg) msg.textContent = t; };
  say("发着呢…");
  try {
    const r = await api("/api/private-work/deliver", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ uid: qq }),
    });
    if (r && r.ok) say("发出 " + (r.sent || 0) + " 个 ✓");
    else say("没发出去（" + ((r && r.error) || "重试两次都没成") + "）");
  } catch (e) {
    say("出错：" + e.message);
  }
  pwTickEta();
}

async function saveFriendCfg(qq) {
  const el = $("msg-pw-friends");
  const g = (p) => $("pwf-" + p + "-" + qq);
  const num = (p) => { const v = Number(g(p) && g(p).value); return Number.isFinite(v) && v > 0 ? v : null; };
  const allowEl = g("allow");
  const takeEl = g("takeover");
  const noteEl = g("note");
  const one = {
    allow: allowEl ? !!allowEl.checked : true,
    // ⚠️ 2026-10-15（用户要求）：人工接管 = 这个人的私聊我自己回，机器人别出声 ✓
    takeover: takeEl ? !!takeEl.checked : false,
    timeoutMin: num("timeout"),
    etaMinMin: num("etamin"),
    etaMaxMin: num("etamax"),
    note: noteEl && noteEl.value.trim() ? noteEl.value.trim().slice(0, 40) : null,
  };
  const body = { privateWork: { friends: {} } };
  body.privateWork.friends[qq] = one;
  const r = await api("/api/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  flash(el, r.ok, r.ok ? "已保存" : ("保存失败：" + r.error));
  if (r.ok) await renderWorkMode();
}
async function saveWorkCfg() {
  const el = $("msg-pw-cfg");
  const n = (id, d) => { const v = Number($(id) && $(id).value); return Number.isFinite(v) ? v : d; };
  const r = await api("/api/config", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ privateWork: {
      agentTimeoutMs: Math.round(n("pw-timeout", 15) * 60000),
      etaMinMin: n("pw-etamin", 8),
      etaMaxMin: n("pw-etamax", 240),
      etaJitter: n("pw-jitter", 0.25),
      maxIncomingMB: n("pw-inmb", 50),
      maxSendMB: n("pw-outmb", 30),
      maxFilesDirect: n("pw-direct", 3),
      dailyMax: n("pw-daily", 5),
      maxConcurrent: n("pw-maxconc", 5),
      friendRefreshMs: Math.round(n("pw-refresh", 10) * 60000),
    } }),
  });
  flash(el, r.ok, r.ok ? "已保存（立刻生效）" : ("保存失败：" + r.error));
}
/**
 * ⚠️⚠️ 2026-10-19 改成**明确动作**（用户：「**这两个开关还是有问题，现在根本点不动**」）。
 *
 * 这一处他已经报了三回：先「打不开」、再「关不了」、再「点不动」，
 * 后来又截图「点了关，但服务端现在是开 —— 没生效」。
 *
 * ⚠️ 后端**每一次都写成功了**（`accounts/<QQ>.yml` 里确实是新值，带不带页面那个
 *    `x-saki-account` 头我都实测过，两个方向都对）。
 *    病根是**读回那一步**：原来走 `GET /api/accounts` —— 那个接口要遍历所有号逐个探活、
 *    还要重建整张表，中间任何一处抛异常，`ACC_LIST` 就停在旧值 ⇒ 拿旧值当答案 ✗
 * ⇒ 现在：
 *   ① 用 `GET /api/switches`（只读内存、不探活、不碰 DOM，秒回）；
 *   ② 回话**直接把服务端读到的那两个值说出来** —— 万一还对不上，一眼就知道卡在哪 ✓
 */
async function accSetWorkMode(on) {
  const want = on === true;
  const el = $('msg-acc-workmode');
  flash(el, true, want ? '正在开启…' : '正在关闭…');
  const r = await api('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ privateWork: { enable: want } }),
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) {
    flash(el, false, '没成功：' + (r?.error || '不知道为啥（看看服务端日志）'));
    return;
  }
  // ⚠️ 读回只问那个轻接口（不探活、不重建表）
  const sw = await api('/api/switches').catch(() => null);
  if (!sw || !sw.ok) {
    flash(el, true, '存进去了，但读不回状态 —— 刷新一下页面看那句"当前：…"');
    await renderAccounts().catch(() => {});
    return;
  }
  const real = sw.workMode === true;
  accShowSwitchState(sw);
  flash(
    el,
    real === want,
    real === want
      ? (real ? '已开启（现在按接单走）' : '已关闭（现在不接单）')
      : `⚠️ 点了${want ? '开' : '关'}，但服务端读到的是「${real ? '开' : '关'}」 —— 没生效（刷新页面再试一次）`,
  );
}

/** 把「当前：开/关」那两句刷成轻接口读到的最新值（不依赖那个重的号列表） */
function accShowSwitchState(sw) {
  const s = sw || {};
  const w = $('state-acc-workmode');
  const t = $('state-acc-takeover');
  if (w) {
    w.textContent =
      s.workMode === undefined ? '当前：读不到状态' : s.workMode ? '当前：已开启' : '当前：已关闭';
  }
  if (t) {
    t.textContent =
      s.takeover === undefined
        ? '当前：读不到状态'
        : s.takeover
          ? '⚠️ 当前：已接管 —— 这个号一条消息都不发'
          : '当前：未接管';
  }
}

/**
 * ⚠️ 2026-10-14 加：**人工接管**（一号一份、默认关）——
 * 打开时那个号一条消息都不发（连 @ 都不回），但**聊天照常落盘**（关掉后接得上）。
 * 后端是 `POST /api/config` → `splitPatch()`：`humanTakeover` 不在共用段里 ⇒
 * 它会自动写进 `accounts/<QQ>.yml`（只有这个号变）✓
 */
async function accSetTakeover(on) {
  const want = on === true;
  const el = $('msg-acc-takeover');
  flash(el, true, want ? '正在接管…' : '正在交还…');
  const r = await api('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ humanTakeover: { enable: want } }),
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) {
    flash(el, false, '没成功：' + (r?.error || '不知道为啥（看看服务端日志）'));
    return;
  }
  // ⚠️ 和上面一样：读回只问轻接口（不探活、不重建表）✓
  const sw = await api('/api/switches').catch(() => null);
  if (!sw || !sw.ok) {
    flash(el, true, '存进去了，但读不回状态 —— 刷新一下页面看那句"当前：…"');
    await renderAccounts().catch(() => {});
    return;
  }
  const real = sw.takeover === true;
  accShowSwitchState(sw);
  flash(
    el,
    real === want,
    real === want
      ? (real ? '已接管：这个号现在一条都不发了（消息照常记着）' : '已交还：机器人恢复说话')
      : `⚠️ 点了${want ? '接管' : '交还'}，但服务端读到的是「${real ? '接管中' : '未接管'}」 —— 没生效（刷新页面再试一次）`,
  );
}

/**
 * ⚠️⚠️ 2026-10-16 加（用户截图：「**这两个开关的状态不显示了**」）——
 * 把「私聊工作模式 / 人工接管」两个勾选框刷成**这个号真实的**状态，
 * 并且在旁边写一句**当前状态**（勾选框万一没刷上，这句还在，一眼就能看出来）✓
 *
 * ⚠️ 它必须**自己 try 掉、而且排在画名单之前** —— 原来那段排在 `accPaintNav()` 后面，
 *    那一步抛一次异常，勾选框就永远停在"没勾"，界面上还什么都看不到 ✗
 */
function accPaintSwitches() {
  try {
    const me = (ACC_LIST || []).find((a) => a.self);
    // ⚠️ 2026-10-19：那两个**勾选框已经删了**（换成「开启 / 关闭」两个按钮，见 HTML 里那段注释）——
    //    这里只负责刷**右侧那句当前状态** ✓
    //    ⚠️ 别再加回 `$('acc-workmode').checked = …`：元素不存在了，那样会抛异常，
    //       而下面"当前：已开启/已关闭"那句就永远不更新（界面继续骗人）✗
    const sw = $('state-acc-workmode');
    const st = $('state-acc-takeover');
    if (!me) {
      // 服务端没报出"这个进程在控制的号" ⇒ 明说读不到，别让人以为"是关着的" ✗
      if (sw) sw.textContent = '当前：读不到状态（刷新一次试试）';
      if (st) st.textContent = '';
      return;
    }
    if (sw) sw.textContent = me.workMode ? '当前：已开启' : '当前：已关闭';
    if (st) {
      st.textContent = me.takeover
        ? '⚠️ 当前：已接管 —— 这个号一条消息都不发'
        : '当前：未接管';
    }
  } catch (e) {
    // 不让它影响后面画名单 ✓
  }
}

/**
 * ⚠️⚠️ 2026-10-16 加（用户：「我在测试**接管之后文件还能不能下载下来**，现在我把开关关了，
 *   **能不能对他发的文件进行补回**」）——
 * 人工接管期间文件是收不下来的（那条闸直接 return）⇒ 接管一趟下来他发的文件就漏了。
 * 这个按钮去把最近私聊历史里**有、工作区里没有**的文件补下来 ✓
 */
async function pwBackfill() {
  const qq = String($('pw-backfill-qq')?.value || '').trim();
  const el = $('msg-pw-backfill');
  if (!qq) {
    flash(el, false, '先填 QQ 号');
    return;
  }
  flash(el, true, '正在拉历史、补文件…（大的包要等一会儿）');
  const r = await api('/api/private-work/backfill', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qq }),
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) {
    flash(el, false, '没成：' + (r?.error || '不知道为啥'));
    return;
  }
  const saved = r.saved || [];
  const skipped = r.skipped || [];
  flash(
    el,
    true,
    saved.length
      ? `补下来 ${saved.length} 个：${saved.join('、')}` +
          (skipped.length ? `；${skipped.length} 个没下来（${skipped[0]}）` : '')
      : `扫了 ${r.scanned} 个文件段，**没有新的**（工作区里都有了）` +
          (skipped.length ? `；${skipped.length} 个没下来（${skipped[0]}）` : ''),
  );
  await renderWorkMode();
}

/**
 * ⚠️⚠️ 2026-10-19 加（用户：「**在工作模式的分好友设置那里加一个补回消息
 * 加补看文件的按钮**」）—— 「分好友」每一行那个按钮：补**这个人**的
 * ① 掉线 / 接管那阵子他发的**消息**（进她的上下文）② 那段时间的**文件**。
 *
 * ⚠️ 顺序由后端定（**先消息、后文件**）—— 补文件那条要回他一句「补发一下」，
 *    得先有上下文才不会说岔 ✓
 * ⚠️ 结果**先显示 4 秒再刷新表格** —— 不然表一重建，那句提示就没了，看着像没反应 ✗
 */
async function pwBackfillThis(qq) {
  const q = String(qq || '').trim();
  if (!q) return;
  const el = $('pwbf-msg-' + q);
  flash(el, true, '正在补消息和文件…（大的包要等一会儿）');
  const r = await api('/api/private-work/backfill-both', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ qq: q }),
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) {
    flash(el, false, '没成：' + (r?.error || '不知道为啥'));
    return;
  }
  const m = r.msgs || {};
  const f = r.files || {};
  const saved = Array.isArray(f.saved) ? f.saved : [];
  const skipped = Array.isArray(f.skipped) ? f.skipped : [];
  const bits = [];
  bits.push(
    (m.ok === false ? '消息没补成（' + (m.error || '不知道为啥') + '）' : '消息补了 ' + (m.added || 0) + ' 条')
      + '（扫了 ' + (m.scanned || 0) + ' 条历史）',
  );
  bits.push(saved.length ? '文件补了 ' + saved.length + ' 个：' + saved.join('、') : '文件没有新的');
  if (skipped.length) bits.push(skipped.length + ' 个没下来（' + skipped[0] + '）');
  flash(el, true, bits.join('；'));
  setTimeout(() => void renderWorkMode().catch(() => {}), 4000);
}

async function renderAccounts() {
  const box = $('acc-list');
  if (box) box.innerHTML = '<span class="hint">读取中…</span>';
  const r = await api('/api/accounts').catch(() => null);
  if (!r || !r.ok) {
    if (box) box.innerHTML = '<span class="hint">读不到号列表（服务端出错了）</span>';
    return;
  }
  ACC_LIST = r.accounts || [];
  // ⚠️⚠️ 2026-10-16 修（用户截图：「**这两个开关的状态不显示了**」）——
  //    现场：工作模式那一页两个勾选框**显示成没勾**，可她明明已经开着（旁边那句
  //    "已开启"是我上次点保存留下的），而且**这时候再点保存会把开着的关掉** ✗✗
  //    真因（两条叠在一起）：
  //      ① 这段刷状态的代码原来**排在 `accPaintNav()` 后面** —— 那一步只要抛一次，
  //         勾选框就永远停在 HTML 的默认值（没勾）✗ 而且**静默**，界面上什么都看不出来。
  //      ② 界面上**只有勾选框**：勾少了没有第二处显示当前状态 ⇒ 看不出是"真关了"还是"没刷上"✗
  //    ⇒ ① 提到最前面 + 自己 try 掉（它坏了也不影响后面画名单）；
  //      ② 两个开关旁边各加一句**当前状态**（已开启/已关闭），勾选框骗人的时候一眼能看出来 ✓
  accPaintSwitches();
  accPaintNav();
  // ⚠️ 2026-10-14 加：把「人工接管」那个开关刷成**当前这个号**的真实值
  //    （`a.self` = 这个进程正在控制的号；别的号的接管状态不在这儿显示）
  // ⚠️ 2026-10-16：这段**挪到上面 `accPaintSwitches()`** 里去了（见那边的注释）✓

  // ⚠️⚠️ 拆分状态**每次都同步进 ACC_SELF**（2026-10-07 修）。
  //    它原来只在页面打开时从 `/api/whoami` 取一次 —— 用户在别处拆过之后，
  //    这里还拿着旧值 ⇒ 点「加这个号」被"还没拆分"拦住（用户报的
  //    「为什么加不上新号，一直说没拆分」就是这个）。
  ACC_SELF.split = !!r.split;
  ACC_SELF.needRestart = !!r.needRestart;

  const hintEl = $('acc-split-hint');
  if (hintEl) {
    if (!r.split) {
      hintEl.innerHTML = `<div style="border:1px solid rgba(255,170,60,.5);border-radius:16px;padding:12px 14px;margin:4px 0 12px">
           ⚠️ <b>还没做「多号拆分」</b>：现在所有设置都还存在共用的 <span class="mono">config.yml</span> 里，
           直接加新号的话，<b>新号会继承主号那些设置</b>（群列表、灵敏度、按群设定…）。
           <div class="btns" style="margin-top:8px">
             <button class="act" onclick="accMigrate()">把当前设置拆成多号结构</button>
             <span class="msg" id="msg-acc-split"></span>
           </div>
           <div class="hint" style="margin-top:6px">
             内容等价（只是换个文件存），原 config.yml 会先备份；<b>拆完要重启机器人</b>才生效。
           </div>
         </div>`;
    } else if (r.needRestart) {
      // ⚠️ 磁盘上拆好了、但这个进程还是旧身份 —— 必须重启，否则保存私有设置
      //    仍然会写回共用的 config.yml（那就白拆了）。这条提示不是客套。
      hintEl.innerHTML = `<div style="border:1px solid rgba(120,190,255,.5);border-radius:16px;padding:12px 14px;margin:4px 0 12px">
           ℹ️ 多号结构<b>已经拆好了</b>（<span class="mono">accounts/${esc(r.main || '')}.yml</span>）。
           <b>重启一次机器人</b>，这个进程才会按新结构跑 ——
           不重启的话，在这里保存的"这个号的设置"仍会写回共用的 config.yml。
         </div>`;
    } else {
      hintEl.innerHTML = '';
    }
  }

  const opts = ACC_LIST.map((a) => `<option value="${a.qq}">${esc(accName(a))}</option>`).join('');
  const fill = (id, extra) => {
    const el = $(id);
    if (!el) return;
    const keep = el.value;
    el.innerHTML = (extra || '') + opts;
    if (keep) el.value = keep;
  };
  fill('acc-copy-from');
  fill('acc-copy-to');
  fill('acc-new-copy', '<option value="">不复制（用默认值）</option>');
  // ⚠️ 「复制给哪个号」默认选**下一个**号 —— 加完新号接着就要做这件事
  const toEl = $('acc-copy-to');
  if (toEl && !toEl.value && ACC_LIST.length > 1) toEl.value = ACC_LIST[1].qq;

  if (!box) return;
  if (!ACC_LIST.length) {
    box.innerHTML = '<span class="hint">还没有号（正常应该至少有一个主号）</span>';
    return;
  }
  box.innerHTML = ACC_LIST.map((a) => {
    const on = a.qq === CUR_ACCOUNT;
    const state = a.alive
      ? '<b style="color:#63d68a">在跑</b>'
      : '<span style="opacity:.65">没在跑</span>';
    const bits = [
      `人设 ${esc(a.persona)}`,
      `界面端口 ${a.port}`,
      a.pid ? `PID ${a.pid}` : '',
      // ⚠️ 协议端那一路的状态（多号最容易卡在这儿）
      a.protoPort
        ? `协议端 :${a.protoPort}`
        : a.protoLoggedIn
          ? '协议端：已登录、还没配端口'
          : '协议端：这个号还没登进去',
    ].filter(Boolean).join(' · ');
    return `<div style="display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid rgba(255,255,255,.08);flex-wrap:wrap">
      <div style="flex:1;min-width:260px">
        <div><b>${esc(a.name || '（没写备注）')}</b>
          <span class="mono">${esc(a.qq)}</span>
          ${a.isMain ? '<span class="hint" style="margin-left:6px">主号</span>' : ''}
          <span class="hint" style="margin-left:8px">${state}</span>
          ${a.hasFile ? '' : '<span class="hint" style="margin-left:8px">⚠️ 还没建配置文件</span>'}
        </div>
        <div class="hint" style="margin:3px 0 0">${bits}</div>
      </div>
      <button class="${on ? 'ghost' : 'act'}" ${on ? 'disabled' : ''}
        onclick="accSwitch('${a.qq}')">${on ? '正在控制' : '切到这个号'}</button>
      <button class="ghost" onclick="accRename('${a.qq}')">改名</button>
      ${!a.isMain && !a.protoPort ? `<button class="ghost" onclick="accProvider('${a.qq}')">接协议端</button>` : ''}
      ${a.isMain ? '' : `<button class="ghost" onclick="accRemove('${a.qq}')">删除</button>`}
    </div>`;
  }).join('');
}

/** 切号：整页按那个号重读 */
function accSwitch(qq) {
  CUR_ACCOUNT = String(qq);
  localStorage.setItem('saki-account', CUR_ACCOUNT);
  const a = ACC_LIST.find((x) => x.qq === CUR_ACCOUNT);
  const msg = a && a.alive
    ? `已切到 ${accName(a)}`
    : `已切到 ${CUR_ACCOUNT} —— 它现在**没在跑**，下面几个页面会读不到它的数据（它起来之后就正常了）`;
  flash($('msg-acc'), a && a.alive ? true : null, msg);
  accPaintNav();
  renderAccounts();
  // ⚠️ 必须整页重读：`/api/state` 里带着那个号的配置（按群设定、灵敏度、剧情…）
  reloadAll();
}

/**
 * 「接协议端」：给这个号在协议端配一个 OneBot 端口（用户要求「我自动改协议端配置」）。
 *
 * ⚠️ 两件事分开确认，因为**代价完全不同**：
 *   · 配端口 = 只改文件，正在跑的连接不受影响；
 *   · 重启协议端 = **所有号掉线约 1 分钟**（它们会自动重连）。
 * ⚠️ 前置条件自动化不了：新号必须先在协议端自己的界面里**登录过**（扫码），
 *    协议端才会为它生成配置文件。没登录过就在这里如实告诉他。
 */
async function accProvider(qq) {
  const r = await api('/api/accounts').catch(() => null);
  const p = r?.provider;
  if (!p || !p.supported) {
    return flash($('msg-acc'), false, p?.reason || '当前协议端不支持自动配端口');
  }
  const a = (r.accounts || []).find((x) => x.qq === qq);
  if (!a) return flash($('msg-acc'), false, `列表里找不到号 ${qq}`);
  if (!a.protoLoggedIn) {
    return flash(
      $('msg-acc'),
      null,
      `协议端里还没有号 ${qq} 的配置 —— 先在协议端自己的界面（${p.manageUrl || '它的管理页'}）` +
        '把这个 QQ 号登进去（要扫码），登好之后回来再点一次「接协议端」。',
    );
  }
  const okSync = confirm(
    `给号 ${qq} 在协议端配一个 OneBot 端口？\n\n` +
      '· 自动挑一个没被占用的端口（3001 是主号在用的，不会动）\n' +
      '· 同时把这个号的接入点（地址 + token）写进它的配置\n' +
      '· 配好之后要**重启协议端**才生效 —— 那一步会再问你一次',
  );
  if (!okSync) return;
  const r2 = await api('/api/accounts/provider', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'sync', qq }),
  });
  if (!r2.ok) return flash($('msg-acc'), false, r2.error || '配端口失败');
  flash($('msg-acc'), true, `配好了：号 ${qq} 走端口 ${r2.port}。要重启协议端才生效。`);

  const okRestart = confirm(
    `现在重启协议端，让端口 ${r2.port} 生效？\n\n` +
      '⚠️ 所有号会掉线约 1 分钟（它们会自动重连，不用管）。\n' +
      '选「取消」也行 —— 等你下次重启协议端时一起生效。',
  );
  if (!okRestart) return flash($('msg-acc'), null, '端口配好了，等你下次重启协议端时生效。');
  flash($('msg-acc'), null, '正在重启协议端，最长要等 1 分钟…');
  const r3 = await api('/api/accounts/provider', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'restart' }),
  });
  if (!r3.ok) return flash($('msg-acc'), false, r3.error || '重启协议端失败');
  flash(
    $('msg-acc'),
    true,
    `协议端重启完了（${Math.round((r3.waitedMs || 0) / 1000)} 秒）。各号会在几秒内自己重连。`,
  );
  renderAccounts();
}

/**
 * 「机器人池」同步（2026-10-07 用户要求）。
 *
 * ⚠️ `dry=true` 是**只算不改** —— 这一下会改到**所有号**的按群设定，
 *    所以界面上专门留了个"先看看会改什么"的按钮（别让人盲点）。
 * ⚠️ 同名池只追加不删（后端保证），所以你手配的黑祥、小豆那些号不会丢。
 */
async function poolsSync(dry) {
  const r = await api('/api/pools/sync', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ dryRun: !!dry }),
  }).catch(() => null);
  if (!r || !r.ok) return flash($('msg-pools'), false, r?.error || '同步失败');
  const list = r.changed || [];
  if (!list.length) {
    return flash($('msg-pools'), true, (dry ? '【预览】' : '') + ((r.notes || [])[0] || '已经是最新的，不用改'));
  }
  const detail = list
    .map((c) => `${c.qq}：同类 +${c.peersAdded.length}、不同类 +${c.otherAdded.length}`)
    .join('；');
  flash($('msg-pools'), true, `${dry ? '【预览】会改 ' : '改好了：'}${list.length} 个号 —— ${detail}`);
  if (!dry) renderAccounts();
}

/** 拆分：把 config.yml 里属于这个号的设置搬进 accounts/<QQ>.yml */async function accMigrate() {
  const qq = ACC_SELF.qq || '';
  if (!/^\d{5,12}$/.test(qq)) {
    return flash($('msg-acc-split'), false, '读不到主号的 QQ —— 先去「模型」页把「机器人 QQ」填上');
  }
  const okGo = confirm(
    '把当前设置拆成「多号结构」？\n\n' +
      `· 把 config.yml 里属于号 ${qq} 的设置（灵敏度 / 按群设定 / 日常事件 / 剧情…）\n` +
      `  搬进 accounts/${qq}.yml\n` +
      '· config.yml 只留共用的（大模型 / 生图 / 搜索 / 协议端…）\n' +
      '· 原 config.yml 先备份成 config.yml.bak-多号拆分-<时间戳>\n\n' +
      '合并出来的配置逐字不变，但**要重启机器人**才生效。',
  );
  if (!okGo) return;
  const r = await api('/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'migrate', qq }),
  });
  if (!r.ok) return flash($('msg-acc-split'), false, r.error || '拆分失败');
  flash(
    $('msg-acc-split'),
    true,
    `拆好了：${r.moved.length} 段搬进 accounts/${qq}.yml。重启机器人后生效（原文件备份在 ${r.backup}）。`,
  );
  renderAccounts();
}

async function accCreate() {
  const qq = ($('acc-new-qq')?.value || '').trim();
  const name = ($('acc-new-name')?.value || '').trim();
  const copyFrom = $('acc-new-copy')?.value || '';
  if (!/^\d{5,12}$/.test(qq)) return flash($('msg-acc-new'), false, 'QQ 号要填 5~12 位数字');

  // ⚠️ 判断"拆没拆"必须用**刚拉到的**状态（2026-10-07 修）：
  //    页面打开时那份可能早就过时了（用户已经拆过、或者刚重启过机器人），
  //    拿旧值就会一直把他拦在"还没拆分"上 —— 用户报的正是这个。
  const who = await api('/api/whoami').catch(() => null);
  if (who && who.ok) ACC_SELF = { ...ACC_SELF, ...who };

  // ⚠️ 没拆分就加号 = 新号会继承主号的私有设置。先让用户把这一步做掉。
  if (!ACC_SELF.split) {
    const okSplit = confirm(
      '加号之前要先做一次「多号拆分」，否则新号会继承主号那些设置。\n\n' +
        '现在就去拆吗？（拆完要重启机器人，然后再回来加号）',
    );
    if (okSplit) await accMigrate();
    return;
  }
  const r = await api('/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'create', qq, name, copyFrom }),
  });
  if (!r.ok) return flash($('msg-acc-new'), false, r.error || '加号失败');
  flash(
    $('msg-acc-new'),
    true,
    `加好了：${qq}（管理界面端口 ${r.port}）` +
      (copyFrom ? `，设置复制自 ${copyFrom}` : '') +
      '。下一步：在协议端给这个号开一个 WS 端口并登录。',
  );
  if ($('acc-new-qq')) $('acc-new-qq').value = '';
  if ($('acc-new-name')) $('acc-new-name').value = '';
  renderAccounts();
}

async function accCopy() {
  const from = $('acc-copy-from')?.value || '';
  const to = $('acc-copy-to')?.value || '';
  if (!from || !to) return flash($('msg-acc-copy'), false, '先把两个号选上');
  if (from === to) return flash($('msg-acc-copy'), false, '源和目标不能是同一个号');
  const okGo = confirm(
    `把 ${from} 的设置整个复制给 ${to}？\n\n` +
      '会覆盖目标号同名的设置（灵敏度 / 按群设定 / 剧情参数…）。\n' +
      '协议端连接、机器人 QQ、备注名不受影响。',
  );
  if (!okGo) return;
  const r = await api('/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'copy', from, to }),
  });
  if (!r.ok) return flash($('msg-acc-copy'), false, r.error || '复制失败');
  flash($('msg-acc-copy'), true, `复制好了：${from} → ${to}（${(r.sections || []).length} 段）`);
  renderAccounts();
}

async function accRename(qq) {
  const a = ACC_LIST.find((x) => x.qq === qq) || { qq };
  const name = prompt(`号 ${qq} 的备注名（自己看的，填这个号在干什么）`, a.name || '');
  if (name === null) return;
  const r = await api('/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'rename', qq, name }),
  });
  if (!r.ok) return flash($('msg-acc'), false, r.error || '改名失败');
  flash($('msg-acc'), true, '改好了');
  renderAccounts();
}

async function accRemove(qq) {
  const okGo = confirm(
    `删掉号 ${qq} 的配置文件？\n\n` +
      '只删配置文件，它的运行数据（state/accounts/…、群记忆）都留着。\n' +
      '原文件会先备份到 accounts/_deleted/，可以手动拿回来。',
  );
  if (!okGo) return;
  const r = await api('/api/accounts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'remove', qq }),
  });
  if (!r.ok) return flash($('msg-acc'), false, r.error || '删除失败');
  flash($('msg-acc'), true, `删掉了 ${qq}（备份：${r.backup}）`);
  if (CUR_ACCOUNT === qq) {
    CUR_ACCOUNT = ACC_SELF.qq || '';
    localStorage.setItem('saki-account', CUR_ACCOUNT);
    reloadAll();
  }
  renderAccounts();
}

// ── 这个标签页是不是旧的？（2026-09-15 加）──
// ⚠️ 起因：用户点「立即发送」后事件**变了一条**才发出去。查明是**这个标签页还是旧页面** ——
//    界面没有轮询，服务端的 webui.html 改了，开着的标签页不会知道，
//    旧页面的 lifeSendNow() 不传预览 → 服务端只好重新抽一条。
//    所以这里每 60 秒跟服务端比一次版本，不一致就在底下挂一条提示让人刷新。
// ⚠️ 2026-10-22：脚本拆到 /assets/webui-app.js 之后，服务端再也替换不到这里的
//    `__PAGE_VER__` 了 —— 改成**从自己的 <script src="...?v=NNN"> 里读**。
//    服务端渲染 html 时把版本号拼进 URL（见 webui.js 的 loadPage），
//    这个值跟 `/api/pagever` 返回的一致，比对逻辑一个字没变。
const PAGE_VER = (() => {
  try {
    const src = (document.currentScript && document.currentScript.src) || '';
    const m = /[?&]v=(\d+)/.exec(src);
    return m ? m[1] : '0';
  } catch { return '0'; }
})();
let pageStaleShown = false;
async function checkPageVer() {
  try {
    const r = await (await fetch('/api/pagever', { cache: 'no-store' })).json();
    if (!r || !r.ver || String(r.ver) === String(PAGE_VER) || pageStaleShown) return;
    pageStaleShown = true;
    const bar = document.createElement('div');
    bar.style.cssText = 'position:fixed;left:0;right:0;bottom:0;z-index:9999;background:#8a6d1f;color:#fff;' +
      'padding:10px 14px;font:14px/1.5 system-ui,sans-serif;text-align:center;cursor:pointer;box-shadow:0 -2px 8px rgba(0,0,0,.25)';
    bar.textContent = '⚠️ 服务端的界面文件更新过了，这个标签页还是旧的（按钮行为可能不一样）—— 点这里刷新';
    bar.onclick = () => location.reload();
    document.body.appendChild(bar);
    document.title = '⚠️ 该刷新了 · ' + document.title;
  } catch {}
}
setInterval(checkPageVer, 60000);
checkPageVer();

function flash(el, ok, text) {
  el.className = 'msg show ' + (ok === true ? 'ok' : ok === false ? 'err' : 'warn');
  el.textContent = text;
  if (ok === true) setTimeout(() => { el.className = 'msg'; }, 5000);
}

function lines(str) {
  return String(str || '').split('\n').map(s => s.trim()).filter(Boolean);
}

// ── 标签页 ──
document.querySelectorAll('nav button').forEach(b => {
  b.onclick = () => {
    document.querySelectorAll('nav button').forEach(x => x.classList.remove('on'));
    b.classList.add('on');
    // ⚠️ 这个列表必须跟 nav 里的 data-tab 一一对应 —— 漏了哪个，哪个标签就切不过去
    //    （qzone 就漏过一阵子，面板永远显示不出来；
    //     2026-10-15 加「B站分享」时**又漏了一次** —— `bili` 没加进这个数组 ⇒
    //     点过去是一片空白（连卡片都不显示，因为它的 section 一直挂着 `hidden`）✗
    //     ⇒ 现在有一条套件断言**自动对账**（`test/webui.js`：每个 `data-tab` 都得在这个数组里）✓）
    ['model','groups','faces','knowledge','persona','qzone','plot','bili','voice','affinity','workmode','qqlogin','status','about','accounts'].forEach(t => {
      const el = $('tab-' + t);
      if (el) el.classList.toggle('hidden', t !== b.dataset.tab);
    });
    if (b.dataset.tab === 'knowledge') loadKnowledge();
    if (b.dataset.tab === 'persona') personaRefresh();
    if (b.dataset.tab === 'faces') renderFaces();
    // ⚠️ 2026-09-30：骰娘模式那张卡也在 groups 页里（跟「回复灵敏度」同一页），
    //    所以跟着同一个时机加载。⚠️ 别漏了 —— 漏了就是「进页面标签是空的」。
    // ⚠️ 2026-10-06：海豹转述开关那张卡也在这一页，同样要跟着加载。
    if (b.dataset.tab === 'groups') {
      // ⚠️ 2026-10-22：收紧度滑块**搬回来了**（用户：「这块还是挪回去」）——
      //    切到这一页要填「哪个群」下拉 + 回填滑块。
      loadGroupRespond();
      renderDiceMode();
      // 好友名单那张卡也挪到这一页了（2026-10-22）。
      loadFriendList().catch(() => {});
      fillStrictForGroup().catch(() => {});
    }
    if (b.dataset.tab === 'qzone') renderQzone();
    // ⚠️ 2026-10-22 合并：`life` / `quest` / `groupcfg` 现在是**同一页的三个二级标签**
    //    （「剧情与事件」）。所以这里一次性把三块都刷出来 —— 都是幂等覆盖赋值。
    //    ⚠️ `stopQuestPoll()` 必须留在 `else` 上：切到别的页要停掉剧情轮询，
    //       不然那个定时器会在后台一直跑。
    if (b.dataset.tab === 'plot') {
      renderLife();
      renderQuest();
      renderStoryline();
      renderGroupParams();
      startQuestPoll();
    } else {
      stopQuestPoll();
    }
    // ⚠️ 2026-10-22 合并：`bili` / `biliPub` / `biliCmt` 现在是**同一页的三个二级标签**。
    //    它们背后是两套渲染（分享 `renderBili()`、投稿+评论共用 `renderBiliPub()`），
    //    所以切到这一页时**两个都跑一遍**（幂等，重复调用只是覆盖赋值）。
    if (b.dataset.tab === 'bili') {
      renderBili();
      renderBiliPub().catch(() => {});
    }
    // ⚠️ 2026-10-21 加：语音设置页
    if (b.dataset.tab === 'voice') renderVoice();
    if (b.dataset.tab === 'affinity') renderAffinity();
    if (b.dataset.tab === 'qqlogin') qqRefresh();
    if (b.dataset.tab === 'accounts') renderAccounts();
    // ⚠️ 2026-10-14：工作模式自己一页（两个开关也搬到它顶上了）
    if (b.dataset.tab === 'workmode') renderWorkMode();
    // ⚠️ 2026-10-22：「工具调用」那页已并进「运行状态」，所以钩子跟着挂到 status 上
    //    （单独一个 `if tab==='tools'` 的话它永远不会被触发 —— 那个 tab 已经不存在了）。
    if (b.dataset.tab === 'status') renderTools();
  };
});

/**
 * 切到某个标签页（界面上的按钮用的，比如「日常事件」页里那个「去按群设定」）。
 * ⚠️ 直接复用 nav 按钮自己的 onclick —— 免得两处逻辑各写一遍、以后改一处漏一处。
 */
function showTab(name) {
  const b = document.querySelector(`nav button[data-tab="${name}"]`);
  if (b) b.click();
  else console.warn('没有这个标签页：', name);
}

/**
 * 二级标签（页面内部再分小节）—— 2026-10-22 加。
 *
 * @param {string} scope 一级标签的 id（不含 `tab-` 前缀），例如 `'model'`
 * @param {string} name  子页的 `data-sub` 值
 *
 * ⚠️ 为什么不把状态存内存里：刷新页面后默认停在第一个子页 —— 这是有意的
 *    （界面没做路由，记不住"上次在哪个子页"，反而比随机停在某页更可预期）。
 * ⚠️ 用 `data-sub` 而不是下标：以后调整子页顺序不用改 JS。
 */
function showSubTab(scope, name) {
  const root = document.getElementById('tab-' + scope);
  if (!root) return;
  root.querySelectorAll('.subtabs button').forEach((b) => {
    b.classList.toggle('on', b.dataset.sub === name);
  });
  root.querySelectorAll('.subpage').forEach((p) => {
    p.classList.toggle('on', p.dataset.sub === name);
  });
  // ⚠️ 2026-10-23：知识库的两个数据页 —— 切过去时才拉
  if (scope === 'knowledge' && name === 'observe') loadDiceLog();
  if (scope === 'knowledge' && name === 'summary') oInit();
}

// ── 读取状态 ──
async function reloadAll() {
  // ⚠️⚠️ 2026-09-23 加（用户：「刚进去默认是没显示状态的，我希望一进去就自动显示状态」）：
  //    标签页的加载钩子**只挂在 nav 按钮的 `onclick` 上** ⇒ 页面刚打开时**没人点击**，
  //    **默认标签的内容就永远不加载** ✗（「QQ登录」页因此一直显示初始文案，
  //    得手点一下「刷新状态」才出内容）。
  //    ⇒ 每次 `reloadAll()`（页面加载、以及点「重新读取」都会走）**补跑一次当前激活标签的钩子**。
  //    ⚠️ 用 `.click()` 复用那个处理器，而不是把那一长串 `if (tab === …)` 再写一遍 ——
  //      和 `showTab()` 的注释同一个道理：两处各写一遍，以后改一处必漏一处。
  //    ⚠️ 放在开头：各 tab 的钩子自己去要自己的数据，不依赖 `STATE`。
  //    ⚠️ `setTimeout(…,0)`：让 `reloadAll` 的主体先跑完，避免在同一 tick 里重入。
  setTimeout(() => {
    try { document.querySelector('nav button.on')?.click(); } catch {}
  }, 0);
  const r = await api('/api/state');
  if (!r.ok) return;
  STATE = r;
  const c = r.config;
  fillQuestGroup();                        // 「立即开始剧情」发到哪个群（1 档群列表）

  // ⚠️ 2026-10-07 多 QQ 号：这行也标出"现在控制哪个号" ——
  //    侧栏按钮上虽然挂着，但那是要眯着眼找的；这一行一眼就能看见。
  const meAcc = ACC_LIST.find((a) => a.qq === CUR_ACCOUNT);
  $('hdr').textContent =
    (CUR_ACCOUNT ? `【${meAcc?.name || CUR_ACCOUNT}】 ` : '') +
    `表情 ${r.stats.faces} · 学到 ${r.stats.learned} 条 · ${c.llm.model}`;

  // 身份（主人 / 机器人）—— 2026-09-15 用户要求：可编辑，而且「群主」改称「主人」
  $('id-ownerQQ').value = c.ownerQQ || '';
  $('id-botQQ').value = c.botQQ || '';
  // ⚠️ 2026-09-28：主人的各种叫法（`config.ownerAliases`）也在这张卡里，
  //    ⚠️ 顺序有讲究：先填 hidden input，再 tagsSync 把它渲染成标签。
  $('id-ownerAliases').value = (c.ownerAliases ?? []).join('、');
  tagsSync('id-ownerAliases');
  // ⚠️ 2026-10-22：「她怎么叫他」（`id-ownerName` / `id-ownerFormal`）原来是**懒加载** ——
  //    只在输入框获得焦点时才去读，所以一进页面那两个框是空的、看着像没配。
  //    现在跟其他字段一样，进来就填（`loadOwnerName()` 只在值为空时写，重复调用无害）。
  //    ⚠️ 不 await：它要打两个接口（persona/list + persona?id=），别拖慢整页初始化。
  if (typeof loadOwnerName === 'function') loadOwnerName().catch(() => {});

  // 模型
/* ⚠️⚠️ 2026-10-22 改：原来这张「大模型」卡已经并进下面的「模型提供商」了
   *    （用户：「为什么还要留两套一样的设置」+「把大模型那里本来有的设置直接全部剪切过来」）
   *    ⇒ 这几个框**已经不存在**，这里不能再碰它们：
   *      · `$('llm-baseURL').value = …` 和 `$('llm-apiKey').value = …` 会 `Cannot set properties of null`
   *      · `fillModelSelect(...)` / `loadModels({silent:true})` 的默认 id 都指向这些框 ⇒ 也会炸
   *    ⚠️ 一旦在这里抛错，**后面整段都不会执行** —— 备选模型（bk*）、慢消息开关、
   *       思考链开关全都填不上，界面上看着像"我改了备用模型没生效" ✗
   *    ⇒ 主模型那套改由 `loadProviders()` 渲染（第一个就是主模型）✓
   *    ⚠️ 备选模型那一套（`llm-bk*` / 勾选时启用）**一个字都没动**，还是原来的用途 ✓ */  renderQzone();
  $('qz-face').innerHTML =
    '<option value="">不配图</option>' +
    FACES.map((f) => '<option value="' + esc(f.tag) + '">' + esc(f.tag) + '</option>').join('');
  // ⚠️ 2026-10-22 加：多提供商列表 + 存档 + 降级状态（用户要的三件）
  loadProviders();
  const visionModel = $('vision-model');
  if (visionModel) visionModel.value = c.vision?.model || '';
  // ⚠️ 2026-10-07：慢模型丢弃积压（**默认开** —— 只有明确写成 false 才算关）
  $('llm-slowDrop').checked = c.llm.slowQueueDrop !== false;
  // ⚠️ 2026-10-09：判据从"秒"改成"**条**"（用户：「改成超过 3 条消息的个数，
  //    时间还是没有精确对应到」）
  $('llm-slowDropCount').value = Math.round(c.llm.slowQueueDropCount ?? 3);
  // ⚠️ 2026-10-19：剧情里「不拒绝 / 不警示 / 不做道德评估」的开关（**默认关** ——
  //    只有明确写成 true 才算开，老配置里没这个键就是关 ✓）
  $('llm-unfiltered').checked = c.llm.unfiltered === true;
  // ⚠️ 2026-10-09：三类对话关思考链的开关。默认按用户定的：机器人之间 = 关，剧情里和真人 = 开 ✓
  $('llm-thinkPeer').checked = (c.llm.thinking?.peer ?? true) !== false;
  $('llm-thinkQuestPeer').checked = (c.llm.thinking?.questPeer ?? true) !== false;
  $('llm-thinkQuest').checked = c.llm.thinking?.quest === true;
  // ⚠️ 2026-10-09：备选模型 —— 三个场景**各一个勾**（和"关思考链"那三个并排 ✓）
  $('llm-bkPeer').checked = c.llm.backup?.for?.peer === true;
  $('llm-bkQuestPeer').checked = c.llm.backup?.for?.questPeer === true;
  $('llm-bkQuest').checked = c.llm.backup?.for?.quest === true;
  $('llm-bkBase').value = c.llm.backup?.baseURL || '';
  // ⚠️ 2026-10-09：备选模型名现在是**下拉**（和主模型一样，可以点"从 API 拉取"）✓
  fillModelSelect([c.llm.backup?.model].filter(Boolean), c.llm.backup?.model || '', 'llm-bkModel');
  $('llm-bkKey').value = c.llm.backup?.apiKey || '';
  // ⚠️ 2026-10-20：备选模型自己的温度（**留空 = 跟主模型一样** ⇒ 存成空串，
  //    不是 0 —— 0 是"完全确定性"，跟"没配"是两回事 ✗）
  $('llm-bkTemperature').value =
    c.llm.backup?.temperature === undefined || c.llm.backup?.temperature === null
      ? ''
      : c.llm.backup.temperature;

  // 生图
  const ig = c.imagegen || {};
  $('ig-enable').checked = !!ig.enable;
  $('ig-provider').value = ig.provider || 'ark';
  // ⚠️ 顺序：先把值填进去，再调 igProviderChanged() 更新 placeholder
  //    （它在"值为空"时会塞预设的默认尺寸，直接覆盖用户存的空值是有意的）
  $('ig-baseURL').value = ig.baseURL || '';
  $('ig-model').value = ig.model || '';
  $('ig-size').value = ig.size || '';
  // 固定画风那层（界面上可改可存）
  $('ig-style-self').value = (ig.style && ig.style.self) || '';
  $('ig-style-scene').value = (ig.style && ig.style.scene) || '';
  $('ig-apiKey').value = ig.apiKey || '';
  $('ig-timeoutMs').value = ig.timeoutMs ?? 180000;
  $('ig-cooldownMs').value = ig.cooldownMs ?? 60000;
  $('ig-keepHours').value = ig.keepHours ?? 24;
  igProviderChanged();
  igCacheInfo();

  // 活跃度（内部仍是 groups）
  // ⚠️ 2026-10-22：`trigger-allowGroups` 那个 textarea 删了（改成列表勾选，见 loadGroupRespond），
  //    这里不能再填它 —— `$('trigger-allowGroups')` 是 null，会 `null.value` 报错并把 reloadAll 带停。
  $('trigger-allowPrivateUsers') && ($('trigger-allowPrivateUsers').value = (c.trigger.allowPrivateUsers || []).join('\n'));
  $('trigger-groupChat').checked = !!c.trigger.groupChat;
  $('trigger-privateChat').checked = !!c.trigger.privateChat;
  $('trigger-historyRounds').value = c.trigger.historyRounds ?? 6;
  $('trigger-cooldownMs').value = c.trigger.cooldownMs ?? 2000;

  // 单人频率闸（2026-10-02）
  // ⚠️ 默认值必须和 `config.js` 里的**同一份**（5 分钟 / 3 / 6），
  //    不然界面上显示的数字和实际生效的不一样，调了没反应还会以为功能坏了。
  const pu = (c.chat && c.chat.perUser) || {};
  $('chatPerUser-enable').checked = pu.enable === true;
  $('chatPerUser-windowMs').value = pu.windowMs ?? 300000;
  $('chatPerUser-softLimit').value = pu.softLimit ?? 3;
  $('chatPerUser-hardLimit').value = pu.hardLimit ?? 6;

  // ⚠️ 召唤频率闸。默认值必须和 `config.js` 同一份（2 分钟 / 10）——
  //    不然界面显示的和实际生效的不一样，调了没反应还会以为功能坏了。
  const puc = (c.chat && c.chat.perUserCall) || {};
  $('chatPerUserCall-enable').checked = puc.enable === true;
  $('chatPerUserCall-windowMs').value = puc.windowMs ?? 120000;
  $('chatPerUserCall-limit').value = puc.limit ?? 10;

  // QQ空间
  if (c.qzone) {
    $('qz-enable').checked = c.qzone.enable !== false;
    $('qz-auto').checked = c.qzone.auto !== false;
    $('qz-maxPerDay').value = c.qzone.maxPerDay ?? 3;
    $('qz-cooldownHours').value = Math.round(((c.qzone.cooldownMs ?? 14400000) / 3600000) * 2) / 2;
    $('qz-ugcRight').value = String(c.qzone.ugcRight ?? 1);
    // ⚠️ 2026-09-28：评论回复的开关 —— 它是**子对象** `qzone.comment`，不是 `qzone` 的直接字段
    $('qz-comment').checked = c.qzone.comment?.enable !== false;
  }

  // 日常事件（一级）
  // ⚠️ 2026-09-16：全局那张「节奏设置」卡**删掉了**（参数完全按群，去「按群设定」页）。
  //    所以这里**只刷新状态**，不再回填那些已经不存在的输入框
  //    （原来 `$('life-minPerDay').value = ...` 会直接抛错，把后面的初始化全带停）。
  if (c.life) renderLife();

  // 灵敏度：没配过就从 requireAtInGroup 推断（true→3，false→1）
  const lvl = [1,2,3].includes(Number(c.trigger.respondTo))
    ? Number(c.trigger.respondTo)
    : (c.trigger.requireAtInGroup === false ? 1 : 3);
  document.querySelectorAll('input[name=respondTo]').forEach(r => {
    r.checked = Number(r.value) === lvl;
  });
  // ⚠️ 2026-10-22：收紧度滑块**已从这一页搬到「按群设定」** —— 原来这里要填
  //    `$('strictness').value`，控件删掉之后那行会 `Cannot set properties of null`
  //    并**把整个 reloadAll 带停**（后面所有页面都填不上，看着像"界面炸了"）。
  //    现在这一页不碰收紧度。
  // ⚠️ 这两个兜底值必须和 config.yml 一致 —— 原来写的是 260 / 700（那套"一大段"的老节奏），
  //    早就过时了；配置读不到时界面会显示错的数字。
  $('chunking-maxChars').value = c.chunking?.maxChars ?? 60;
  $('chunking-delayMs').value = c.chunking?.delayMs ?? 1000;
  $('chunking-delayMaxMs').value = c.chunking?.delayMaxMs ?? '';

  // 教学
  $('teach-teachers').value = (c.teach.teachers || []).join('\n');
  $('teach-allowPrivateTeach').checked = c.teach.allowPrivateTeach !== false;
  $('teach-keywords').value = (c.teach.keywords || []).join(',');

  // 实查
  $('status-enable').checked = !!c.status.enable;
  $('status-host').value = c.status.host || '';
  $('status-displayName').value = c.status.displayName || '';
  $('status-cacheSeconds').value = c.status.cacheSeconds ?? 60;

  // 问题提示
  const p = $('problems');
  if (r.problems && r.problems.length) {
    p.innerHTML = '<div class="card" style="border-color:#fde68a;background:#fffbeb">' +
      '<h2 style="color:#d97706">配置有问题</h2>' +
      r.problems.map(x => '<div style="font-size:14px">• ' + esc(x) + '</div>').join('') + '</div>';
  } else {
    p.innerHTML = '';
  }

  // 状态页
  $('stats').innerHTML =
    kv('机器人账号', c.botQQ ? esc(c.botQQ) + '（登录脚本用它快速登录）' : '— 未配置') +
    // ⚠️ 2026-09-15：这里原来叫「群主」，用户要求**改称「主人」**；
    //    而且它不再是只读的 —— 想改去上面「身份（主人 / 机器人）」那张卡片。
    kv('主人', c.ownerQQ ? esc(c.ownerQQ) + '（对他说话是同级口吻；要改去上面那张卡片）' : '— 未配置') +
    kv('表情库', r.stats.faces + ' 张') +
    kv('学到的知识', r.stats.learned + ' 条') +
    kv('知识库', r.stats.knowledge ? '已加载' : '未加载') +
    kv('服务器状态', esc(r.server?.text || '—'));

  $('paths').innerHTML =
    kv('配置文件', '<span class="mono">' + esc(r.files.config) + '</span>') +
    kv('数据目录', '<span class="mono">' + esc(r.files.root) + '</span>') +
    kv('NapCat 连接', '<span class="mono">' + esc(c.onebot.mode + ' ' + c.onebot.url) + '</span>');

  $('learned-count').textContent = r.stats.learned + ' 条';
  {
    const tc = (r.config && r.config.teach) || {};
    const e1 = $('teach-enable');
    const e2 = $('teach-notify');
    if (e1) e1.checked = tc.enable !== false;
    if (e2) e2.checked = tc.notify !== false;
  }
  LEARNED_TOPICS = r.learnedTopics || [];
  learnedFilter();
  // 开机自启（状态页那张卡片）—— 它自己会判元素在不在，不会把上面这些东西带停
  loadAutostart();
  // 自动清理（2026-10-06 加）—— 同上，自己判元素在不在
  loadCleanup();

  renderFaces();
}

const esc = (s) => String(s ?? '').replace(/[&<>"]/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
const kv = (k, v) => `<div class="kv"><b>${esc(k)}</b><span>${v}</span></div>`;

// ── 自动清理（2026-10-06 加，用户要求）──
//
// ⚠️ 「立刻清一次」要二次确认：这个按钮**真删文件**（白名单不动，但删了就是删了）。
// ⚠️ 每个元素先判存在再用 —— 这个文件里有过一次事故（见上面那段注释）。
async function loadCleanup() {
  const box = $('cleanup-status');
  if (!box) return;
  let r;
  try {
    r = await api('/api/cleanup');
  } catch (e) {
    box.innerHTML = kv('读取失败', esc(e.message));
    return;
  }
  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
  box.innerHTML =
    r.dirs.map((d) => kv(d.label, `${mb(d.bytes)}<span class="hint"> · ${d.files} 个文件</span>`)).join('') +
    kv('待清（已超期）', `<b>${r.dueCount} 项 / ${mb(r.dueBytes)}</b>`) +
    kv(
      '保留期',
      `文件缓存 ${r.days.uploadedDays} 天 · 临时目录 ${r.days.tmpDays} 天 · 日志 ${r.days.logDays} 天 · 待审表情 ${r.days.pendingDays} 天`,
    ) +
    kv('开关', r.enable ? (r.dryRun ? '✅ 开着（当前是"只演练、不真删"）' : '✅ 开着') : '⛔ 已关闭（config.yml 的 cleanup.enable）');
}

async function cleanupRun(dryRun) {
  const msg = $('cleanup-msg');
  const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
  if (!dryRun && !confirm('真要删吗？删的是临时产物（白名单不动，但删了就是删了）。')) return;
  if (msg) msg.textContent = '正在跑…';
  try {
    const r = await api('/api/cleanup', { method: 'POST', body: JSON.stringify({ dryRun }) });
    if (msg) {
      msg.textContent = dryRun
        ? `预览：可清 ${r.deleted.length} 项 / ${mb(r.freedBytes)}（一个都没删）`
        : `清完了：${r.deleted.length} 项 / 省 ${mb(r.freedBytes)}`;
    }
    loadCleanup();
  } catch (e) {
    if (msg) msg.textContent = `出错：${e.message}`;
  }
}

// ── 开机自启（2026-09-17 加）──
//
// ⚠️ 每个元素先判存在再用 —— 这个文件里有过一次事故：`$('已经删掉的id').value = ...`
//    直接抛错，把 reloadAll 后面所有初始化全带停了（见上面「日常事件」那段注释）。
// ⚠️ 状态里的 `stale` 是"开过、但项目挪了位置，自启项还指着旧路径" ——
//    这种要显眼地说出来，否则用户会以为"开着呢"但开机其实起不来。
// ⚠️⚠️ 2026-10-21 加（用户：「**这个学习做一个开关，再加一个是否有学到提示的开关**」）——
//   ① `enable` 关 ⇒ 一条都不学（后端 `saveKnowledge` 直接返回）
//   ② `notify` 关 ⇒ 照学，但**不在群里回那句"记下了"** ✓
//   ⚠️ `teach` 段在 `saveConfig` 的 `put()` / `HANDLED` / `order` **三处都有** ⇒ 能存进去 ✓
async function teachSet(key, val) {
  const msg = $('teach-msg');
  if (msg) msg.textContent = '正在保存…';
  const patch = {};
  patch[key] = val === true;
  const r = await api('/api/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teach: patch }),
  }).catch((e) => ({ ok: false, error: e.message }));
  if (!r || !r.ok) {
    if (msg) msg.textContent = '没保存成功：' + (r?.error || '看看服务端日志');
    return;
  }
  if (msg) {
    msg.textContent =
      key === 'enable'
        ? val
          ? '✅ 学习已开'
          : '✅ 学习已关（一条都不学）'
        : val
          ? '✅ 学到之后会回一句'
          : '✅ 闷着学，不吭声';
  }
  setTimeout(() => {
    if (msg) msg.textContent = '';
  }, 4000);
}

async function loadAutostart() {
  const box = $('autostart-status');
  if (!box) return;
  let r;
  try {
    r = await api('/api/autostart');
  } catch (e) {
    box.innerHTML = kv('读取失败', esc(e.message));
    return;
  }
  if (!r.supported) {
    box.innerHTML = kv('状态', '不支持') + (r.reason ? kv('原因', esc(r.reason)) : '');
    const on = $('btn-autostart-on'); if (on) on.disabled = true;
    const off = $('btn-autostart-off'); if (off) off.disabled = true;
    return;
  }
  const state = r.enabled ? '✅ 已开启' : (r.stale ? '⚠️ 开着，但指向别的目录' : '未开启');
  box.innerHTML =
    kv('状态', esc(state)) +
    kv('启动项名', '<span class="mono">' + esc(r.valueName) + '</span>（任务管理器的「启动」页里能看到）') +
    kv('开机时跑', '<span class="mono">' + esc(r.launcher) + '</span>') +
    (!r.launcherExists ? kv('⚠️ 注意', '上面那个启动脚本不在（安装包不完整？）') : '') +
    (r.current && !r.enabled ? kv('现在指向', '<span class="mono">' + esc(r.current) + '</span>') : '') +
    (r.reason ? kv('提示', esc(r.reason)) : '');
}

async function autostartSet(on) {
  const msg = $('autostart-msg');
  if (msg) flash(msg, null, on ? '正在开启…' : '正在关闭…');
  try {
    const r = await api('/api/autostart', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: !!on }),
    });
    if (!r.ok) throw new Error(r.error || '操作失败');
    if (msg) {
      flash(msg, true, on
        ? '已开启。下次开机、登录进桌面之后它会自己起来（可以先看 logs\\autostart.log）。'
        : '已关闭，开机不会再自动启动。');
    }
    await loadAutostart();
  } catch (e) {
    if (msg) flash(msg, false, '失败：' + e.message);
  }
}

// ── 模型下拉框 ──

/** 用给定列表填充下拉框，并把 current 选中 */
// ⚠️ 2026-10-09 泛化：多给一个 `selId` —— 备选模型的模型名也用同一个下拉填充 ✓
//    （默认仍是主模型的 `llm-model`，原来那些调用一个字不用改 ✓）
function fillModelSelect(models, current, selId = 'llm-model') {
  const sel = $(selId);
  const want = current || sel.value;
  const list = [...new Set([...(models || []), want].filter(Boolean))];
  sel.innerHTML = list.map(m => `<option value="${esc(m)}">${esc(m)}</option>`).join('');
  if (want && list.includes(want)) sel.value = want;
}

/**
 * 从 API 拉可用模型列表。
 * ⚠️ 2026-10-09 泛化：`opts` 里可以指定「拉哪个框」（备选模型的地址/Key/下拉/提示/按钮）——
 *    用户要求：「**备选模型也要和之前一样可以直接拉取并选择**」✓
 *    不传就是主模型那一套（原来的行为一个字没变 ✓）
 */
async function loadModels(opts = {}) {
  const baseId = opts.baseId || 'llm-baseURL';
  const keyId = opts.keyId || 'llm-apiKey';
  const selId = opts.selId || 'llm-model';
  const hint = $(opts.hintId || 'model-hint');
  const btn = $(opts.btnId || 'btn-models');
  if (!opts.silent) btn.disabled = true;
  if (!opts.silent) { hint.textContent = '正在从 API 拉取模型列表…'; }

  try {
    const r = await api('/api/models', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({
        baseURL: $(baseId).value.trim(),
        apiKey: $(keyId).value.trim(),
      })
    });
    if (r.ok && r.models.length) {
      // ⚠️ 备选那一路用 `datalist`（能选也能手打 ✓），主模型仍是 `<select>`
      if (opts.datalistId) fillDatalist(opts.datalistId, r.models, $(selId).value);
      else fillModelSelect(r.models, $(selId).value, selId);
      hint.textContent = `API 上有 ${r.models.length} 个模型：${r.models.join('、')}`;
      hint.style.color = '#16a34a';
    } else {
      // 拉不到就保留手填能力
      hint.textContent = `拉取失败（${r.error || '未知错误'}）—— 可以直接在下拉框里手打模型名，或者检查 API 地址和 Key。`;
      hint.style.color = '#d97706';
      if (!opts.noEditable) ensureModelEditable();
    }
  } finally {
    if (!opts.silent) btn.disabled = false;
  }
}

/** 填一个 `<datalist>`（备选模型名用 —— 既能从列表选、也能手打 ✓） */
function fillDatalist(id, models, current) {
  const dl = $(id);
  if (!dl) return;
  const list = [...new Set([...(models || []), current].filter(Boolean))];
  dl.innerHTML = list.map((m) => `<option value="${esc(m)}"></option>`).join('');
}

/** 拉备选模型的列表（用的是备选那三个框 ✓） */
/** 拉识图模型的列表 —— 和主模型同一个 API 地址 / Key，只是换个框 */
function loadVisionModels() {
  return loadModels({
    selId: 'vision-model',
    datalistId: 'vision-model-list',
    hintId: 'vision-hint',
    btnId: 'btn-vision-models',
  });
}

function bkLoadModels() {
  return loadModels({
    baseId: 'llm-bkBase',
    keyId: 'llm-bkKey',
    selId: 'llm-bkModel',
    datalistId: 'bk-model-list',
    hintId: 'bk-hint',
    btnId: 'btn-bk-models',
    noEditable: true,
  });
}

/**
 * 「一键填 Gemini」（用户要求：「**要能点击自动填充**」）——
 * 把 baseURL 填好、模型名给一个起点，Key 留给他粘 ✓
 * ⚠️ 模型名**不写死成唯一答案**：填完让他点「从 API 拉取」按真实列表挑 ✓
 */
function bkFillGemini() {
  $('llm-bkBase').value = 'https://generativelanguage.googleapis.com/v1beta/openai';
  if (!$('llm-bkModel').value) $('llm-bkModel').value = 'gemini-2.5-flash';
  const h = $('bk-hint');
  if (h) {
    h.textContent = '已填好 Gemini 的地址（模型名给了个起点）。把 API Key 粘进去 → 点「从 API 拉取」挑模型 → 上面三行勾想用它的那几类 → 保存 ✓';
    h.style.color = '#2563eb';
  }
  $('llm-bkKey').focus();
}

/** 列表为空时，至少放一个可编辑的项，别让用户没得选 */
function ensureModelEditable() {
  const sel = $('llm-model');
  // ⚠️ 2026-10-22：主模型那张卡已经并进「模型提供商」⇒ 这个框**可能不存在**，
  //    这里必须挡一下（否则 `sel.options` 直接抛错，把调用它的整段逻辑带崩）✓
  if (!sel) return;
  if (!sel.options.length) {
    sel.innerHTML = '<option value="">（拉取失败，请直接输入模型名）</option>';
  }
}

// ── 日常事件（一级）──
async function renderLife() {
  const el = $('life-status');
  if (!el) return;
  try {
    const r = await api('/api/state');
    const s = r.life?.status || {};
    const p = r.life?.plan || {};
    const fmt = (ms) => {
      if (!ms) return '—';
      const d = new Date(ms);
      return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
    };
    // ⚠️ 2026-09-16：**每个群各排各的**（分群之后）—— 这张卡先填"发到哪个群"那个下拉框，
    //    再把这个群的进度列出来（不再是"一份全局进度"）。
    const gids = s.targets || [];
    const sel = $('life-group');
    if (sel) {
      const keep = String(sel.value || localStorage.getItem('life-group') || '');
      sel.innerHTML = gids.length
        ? gids.map((g) => `<option value="${esc(g)}">${esc(groupLabel(g))}</option>`).join('')
        : '<option value="">（没有 1 档群）</option>';
      if (gids.length) sel.value = gids.includes(keep) ? keep : gids[0];
    }
    const cur = String(sel?.value || '');
    let per = null;
    if (cur) {
      try {
        const one = await api(`/api/life/status?groupId=${encodeURIComponent(cur)}`);
        if (one?.ok) per = one;
      } catch {}
    }
    const st = per?.status || s;
    const pl = per?.plan || p;
    let html = kv('开关', st.enable ? '<b style="color:#16a34a">开</b>' : '<b style="color:#d97706">关</b>') +
      (cur ? kv('下面是哪个群', `<b>${esc(cur)}</b>`) : '') +
      kv('今天', `已发 ${pl.fired ?? 0} / 目标 ${pl.target ?? 0}`) +
      kv('下次大概', fmt(pl.nextAt)) +
      kv('允许时段', st.window || '7:00-24:00') +
      kv('发到 1 档群', gids.join('、') || '（没有 1 档群）') +
      kv('事件库', `${s.templates ?? 0} 条 / ${s.slots ?? 0} 个时段`);
    // ⚠️ 每个群的进度都列一下（一眼看出"没混在一起"）
    const bg = Array.isArray(s.byGroup) ? s.byGroup : [];
    if (bg.length > 1) {
      html += kv(
        '各群各自算',
        bg
          .map((x) => `${esc(x.groupId)}：${x.fired ?? 0}/${x.target ?? 0}`)
          .join(' · '),
      );
    }
    if (s.today && s.today.length) {
      html += kv('今天是什么日子', `<b style="color:#7c3aed">${esc(s.today.join('、'))}</b>` + (s.off ? '（放假）' : ''));
    }
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = kv('出错', esc(e.message));
  }
}

async function saveLife() {
  // ⚠️ 2026-09-16：全局那张「节奏设置」卡删了（参数**完全按群**）→ 这个函数没有入口了。
  //    留着只为兼容旧页面：元素不在就**什么都不提交**（否则一调用就抛错）。
  if (!$('life-enable')) return;
  const el = $('msg-life');
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ life: {
      enable: $('life-enable').checked,
      holidays: $('life-holidays').checked,
      cooldownMs: Math.round(Number($('life-cooldownMin').value) * 60000),
      lateToleranceMs: Math.round(Number($('life-lateMin').value) * 60000),
    }})
  });
  flash(el, r.ok, r.ok ? '已保存并生效（节奏类参数下次检查时生效）' : ('保存失败：' + r.error));
  if (r.ok) { await reloadAll(); renderLife(); }
}

// ── 日常事件：预览 / 立即发送（<主人>：「日常事件也加一个预览和立即发送」）──
// ⚠️ 「预览一条」抽到的那条（2026-09-15 用户要求「预览和发送合为一条」）：
//    点「立即发送」时把它一起传上去，**发的就是你看过的那一句**，
//    不再重新抽（原来是重新抽，所以你看到的和发出去的不是同一句）。
let lifePreviewed = null;

function renderLifePreview(p, extra) {
  const box = $('life-preview');
  if (!box || !p) return;
  box.innerHTML =
    kv('时段', esc(String(p.slot || '—'))) +
    kv('抽到的事件', esc(String(p.event || '—'))) +
    kv('她会这么说', `<b>${esc(String(p.text || '—'))}</b>`) +
    // ⚠️ 2026-10-13：润色没成功时**真发的时候不发**（事件库原文是第三人称旁白，
    //    直发进群会读成"她在说别人"，用户截图报过）—— 界面上要说清，
    //    别让人以为"预览出来了就会发这一句"。
    (p.unclean
      ? kv('⚠️ 提示', '这次润色没成功 —— <b>群里不会发这条</b>（原文是第三人称旁白，不直发）。下面是抽到的事件原文，只看个大概。')
      : '') +
    (extra ? kv('发送到', esc(extra)) : '');
}

async function lifePreview() {
  const el = $('msg-life2');
  const gid = String($('life-group')?.value || '');
  el.textContent = '正在让模型写一条…（要几秒）';
  const p = await api('/api/life/preview', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ groupId: gid }) });
  if (!p.ok) { el.textContent = '没抽出来：' + (p.reason || ''); return; }
  lifePreviewed = p;                       // ★ 记住这一条，等下"立即发送"就发它
  renderLifePreview(p);
  el.textContent = '预览好了（没发送、也没记账）—— 点"立即发送"发的就是这一条';
}

async function lifeSendNow() {
  const el = $('msg-life2');
  const pre = lifePreviewed;
  const gid = String($('life-group')?.value || '');
  const what = pre?.text ? '你刚预览的那一条' : '现场新抽的一条';
  if (!confirm(`这会**真的**往群 ${gid} 发一条日常事件（发的是${what}），而且**算这个群今天的一条**。\n\n确定吗？`)) return;
  el.textContent = pre?.text ? '正在发送刚预览的那一条…' : '正在写并发送…（要几秒）';
  const r = await api('/api/life/send-now', {
    method: 'POST',
    headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ preview: pre || null, groupId: gid }),
  });
  if (!r.ok) { el.textContent = '没发出去：' + (r.error || ''); renderLifePreview(r); return; }
  lifePreviewed = null;                    // 发过了，下次要重新预览
  renderLifePreview(r, (r.sent || []).join('、'));
  el.textContent = '已发到 ' + (r.sent || []).join('、');
  renderLife();
}

// ── 剧情发展时间线（2026-09-15 晚 <主人>：「把剧情发展呈现在 webui 上更详细一点」）──
// ⚠️ 原来只列「第N段 + 群友回复」，既看不出**先后顺序**，也看不到
//    她自己在群里**顺口接的话**（那句"答应了"的话原来哪儿都没显示）。
//    这里把三段数据合成一条按时间排的时间线：
//      ① 已经写出来的每一段（她说的话 + 世界发生了什么 + 群友的回复）
//      ② 插曲：她在群里顺口接的话（不算分段，但下一段必须跟它一致）
//      ③ 等下一段：群里说了、还没被消化掉的发言
function hm(at) {
  const n = Number(at ?? 0);
  if (!n) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

function questDevHtml(s) {
  const rows = [];
  const row = (at, inner) =>
    `<div style="display:flex;gap:8px;padding:6px 0;border-bottom:1px dashed var(--line)">
      <div style="color:#9ca3af;font-size:12px;min-width:38px">${hm(at)}</div>
      <div class="f1">${inner}</div></div>`;
  for (const st of s.stages || []) {
    const reps = (st.replies || [])
      .map((x) => `<div style="color:#6b7280;font-size:13px;padding-left:8px">↳ ${esc(x.name)}：${esc(x.text)}</div>`)
      .join('');
    rows.push({
      at: Number(st.at ?? 0),
      html: row(
        st.at,
        `<div><b>第 ${st.i} 段</b>　${esc(st.text || '')}</div>` +
          (st.event && st.event !== st.text ? `<div style="color:#6b7280;font-size:13px">（世界：${esc(st.event)}）</div>` : '') +
          reps,
      ),
    });
  }
  for (const x of s.interludes || []) {
    rows.push({
      at: Number(x.at ?? 0),
      html: row(
        x.at,
        `<span style="background:#ede9fe;color:#5b21b6;border-radius:3px;padding:1px 4px;font-size:12px">插曲</span>
         她在群里顺口接的：${esc(x.text)}`,
      ),
    });
  }
  // ⚠️ 2026-09-17 用户要求："等下一段"要能看出**每一条是靠哪条判据进来的**。
  //    ⚠️⚠️ 但**不再分第二类** —— <主人> 当时追问了一句很关键的话：
  //    「**现在不是本来就会筛选一部分消息进入影响剧情的范围吗**」。
  //    对：能进 `pending` 的每一条都已经过了 `isPlotReply()` 那道筛
  //    （`at`/`reply`/`suggest`/`question`/`loose` 五档**都算**"可能改变走向"）。
  //    我上一版把 `loose` 挑出来标成"顺口说的"，是**自己又加了一道判据**，跟设计打架。
  //    所以这里只做一件事：标签统一「等下一段」，括号里写清它是**怎么进来的**。
  const WHY_LABEL = { at: '叫了她', reply: '回她的话', suggest: '给了建议', question: '在问剧情', loose: '随口提了一句' };
  for (const x of s.pendingList || []) {
    const tag =
      '<span style="background:#fef3c7;color:#92400e;border-radius:3px;padding:1px 4px;font-size:12px">等下一段</span>';
    const sub = WHY_LABEL[x.why]
      ? `<span style="color:#9ca3af;font-size:12px">（${WHY_LABEL[x.why]}）</span>`
      : '';
    rows.push({
      at: Number(x.at ?? 0),
      html: row(x.at, `${tag} ${sub}${esc(x.name)}：${esc(x.text)}`),
    });
  }
  if (!rows.length) return '';
  return '<div style="margin-top:4px">' + rows.sort((a, b) => a.at - b.at).map((r) => r.html).join('') + '</div>';
}

// ── 二级剧情 ──

/**
 * 剧情页的自动刷新（2026-09-17 用户反馈：「二级剧情状态不会自动随着群里消息更新」）。
 *
 * ⚠️ 原来只在**切到这一页时**拉一次 `renderQuest()` —— 可是这一页显示的东西
 *    （群友回复攒了几条、她顺口接的话、推进到第几段、还有几分钟自动推）
 *    **全是群里正在发生的事**。停在页面上不动就等于看不见，得手动按 F5。
 *
 * ⚠️ 只在这一页**开着的时候**轮询：切走就停（别在别的页白打接口）。
 * ⚠️ 焦点在这一页的输入框里时**跳过这一轮** —— 回填会把人打了一半的字冲掉。
 */
let questPoll = null;
function stopQuestPoll() {
  if (questPoll) {
    clearInterval(questPoll);
    questPoll = null;
  }
}
function startQuestPoll() {
  stopQuestPoll();
  questPoll = setInterval(() => {
    const el = $('tab-quest');
    if (!el || el.classList.contains('hidden')) {
      stopQuestPoll();
      return;
    }
    const act = document.activeElement;
    if (act && el.contains(act) && /INPUT|TEXTAREA|SELECT/.test(act.tagName)) return;
    renderQuest();
    renderStoryline();
  }, 5000);
}

async function renderQuest() {
  const el = $('quest-status');
  if (!el) return;
  try {
    const r = await api('/api/quest/state');
    const s = r.status || {};
    const c = r.config || {};
    // ⚠️ 2026-09-16：全局那张「参数」卡删了（二级剧情参数**完全按群**，去「按群设定」页）
    //    → 元素不在就跳过回填（不然页面初始化会在这里抛错）。
    if ($('q-enable')) {
      $('q-enable').checked = c.enable === true;
      $('q-chance').value = c.chance ?? 0.1;
      $('q-maxPerWeek').value = c.maxPerWeek ?? 3;
      $('q-waitMin').value = Math.round((c.waitMs ?? 1800000) / 60000);
      $('q-maxStages').value = c.maxStages ?? 10;
      $('q-cold').value = c.coldAutoLimit ?? 1;
      $('q-good').value = c.affinityGood ?? 3;
      $('q-bad').value = c.affinityBad ?? -2;
      $('q-replyMode').value = c.replyMode || 'normal';
    }
    // ⚠️ 「下次二级事件」是**按群**存的（2026-09-15 晚）——
    //    这个框显示/编辑的是「发到哪个群」里选中的那个群那一句。
    //    （每个群的故事线不一样，一句由头只对写它的那个群有意义）
    const hintGid = String($('q-group')?.value || '');
    const hints = s.hints || {};
    const hintText = hints[hintGid] || (hintGid ? '' : (s.nextHint || ''));
    if (document.activeElement !== $('q-hint')) $('q-hint').value = hintText;

    let html = kv('自动开启', s.enable
      ? '<b style="color:#16a34a">开</b>（会掷骰子自动开剧情）'
      : '<b style="color:#d97706">关</b>（不会自动开；手动和模拟都能用）') +
      kv('现在', s.running ? `<b style="color:#7c3aed">在跑（第 ${s.stage} / 计划 ${s.plannedStages} 段）</b>` : '没有在跑的剧情') +
      kv('最近 7 天', `${s.weeklyUsed ?? 0} / ${s.maxPerWeek ?? 3} 条`);
    if (s.running) {
      // ⚠️ 2026-09-15 晚加：这一段原来只报"起因/发在/回过几次"，
      //    用户要求「把剧情发展呈现在 webui 上更详细一点」——现在把
      //    进度、等待窗口、结局好感度、以及**按时间排的整条发展**都摆出来。
      const waitedMin = s.awaitingSince ? Math.max(0, Math.round((Date.now() - s.awaitingSince) / 60000)) : 0;
      const waitMin = Math.round((s.waitMs ?? 1800000) / 60000);
      const leftMin = Math.max(0, waitMin - waitedMin);
      html += kv('起因', esc(s.premise || '')) +
        kv('发在', `群 ${esc(s.groupId || '—')}` + (s.topicLabel ? ` · 题材「${esc(s.topicLabel)}」` : '')) +
        kv('进度', `第 ${s.stage} / 计划 ${s.plannedStages} 段（最多 ${c.maxStages ?? 10} 段）`) +
        kv('这一段', `已经等了 ${waitedMin} 分钟` +
          (leftMin > 0
            ? `，最多等 ${waitMin} 分钟（约 ${leftMin} 分钟后自动推下一段）`
            : `，<b style="color:#7c3aed">已经到点</b> —— 下一次检查就推下一段`)) +
        kv('群友回过', `${s.humanReplies ?? 0} 次` +
          ((s.pending ?? 0) ? `（还有 ${s.pending} 句等着进下一段）` : '（现在没有等着的话）')) +
        kv('自动续写', `${s.autoContinues ?? 0} 次（连着 ${c.coldAutoLimit ?? 1} 次没人回应就收尾）`) +
        kv('结局影响', `好结局 ${(c.affinityGood ?? 3) > 0 ? '+' : ''}${c.affinityGood ?? 3} · ` +
          `坏结局 ${c.affinityBad ?? -2}（<b>只给参与过的人</b>）`) +
        kv('参与过的人', `${(s.cast || []).length} 人`);
      const dev = questDevHtml(s);
      if (dev) {
        html += '<div class="mt12"><b style="font-size:13px">剧情发展（按时间）</b>' +
          '<div class="hint" style="margin:2px 0 0">紫标＝她在群里顺口接的话（也算数）；黄标＝群里说了、还没进下一段</div>' +
          dev + '</div>';
      }
      // 控制卡片那边显示"现在哪个群在跑"
      const nowEl = $('qc-now');
      if (nowEl) nowEl.textContent = `现在在跑：群 ${s.groupId}（第 ${s.stage} / 计划 ${s.plannedStages} 段）`;
      const sel = $('qc-group');
      if (sel && s.groupId && (sel.value !== String(s.groupId)) && !sel.dataset.touched) {
        sel.value = String(s.groupId);           // 默认选"正在跑的那个群"
      }
    } else {
      const nowEl = $('qc-now');
      if (nowEl) nowEl.textContent = '现在没有在跑的剧情（先用上面的「立即开始剧情」开一条）';
    }
    if (hintText) {
      html += kv(`下次二级事件（群 ${esc(hintGid || '全局兜底')}）`, '<b style="color:#d97706">' + esc(hintText) + '</b>');
    }
    // 别的群也各存了句子由头 → 列出来（省得以为"只有一份"）
    const otherHints = Object.entries(hints).filter(([g, t]) => t && g !== hintGid);
    if (otherHints.length) {
      html += kv('别的群各存了',
        otherHints.map(([g, t]) => `群 ${esc(g)}：${esc(String(t).slice(0, 24))}`).join('<br>'));
    }
    if (s.recent && s.recent.length) {
      html += '<div class="mt10"><b style="font-size:13px">最近几条</b>' +
        // ⚠️⚠️ 2026-09-18 修（用户报「最终一共多少段和 webui 上的数字没对上」）：
        //    `recent[]` 里存的是**整个 quest 对象**，所以 `x.stages` 是**每段的数组**
        //    （不是段数！）—— 原来直接 `${x.stages}` 会渲染成一串 `[object Object]`。
        //    同时把"实际段数 vs 原计划段数"一起显示：两者**本来就可能不等**
        //    （她会提前收尾、也会因为群里热情而加演），标出来就不会再被当成 bug。
        s.recent.map((x) => {
          const n = Array.isArray(x.stages) ? x.stages.length : Number(x.stages) || 0;
          const plan = Number(x.plannedStages) || 0;
          const tail = plan && plan !== n ? `，原计划 ${plan} 段` : '';
          return `<div style="font-size:13px;color:#6b7280;padding:2px 0">
          ${x.ending === 'good' ? '🟢' : '🔴'} ${esc(x.premise || '')}（${n} 段${tail}）</div>`;
        }).join('') + '</div>';
    }
    el.innerHTML = html;

    const sim = r.sim || {};
    renderSim(sim);
  } catch (e) {
    el.innerHTML = kv('出错', esc(e.message));
  }
}

async function saveQuest() {
  // ⚠️ 2026-09-16：全局那张「参数」卡删了（二级剧情参数**完全按群**，去「按群设定」页）
  //    → 没有入口了；元素不在就别提交（不然一调用就抛错）。
  if (!$('q-enable')) return;
  const el = $('msg-quest');
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ quest: {
      enable: $('q-enable').checked,
      chance: Number($('q-chance').value),
      maxPerWeek: Number($('q-maxPerWeek').value),
      waitMs: Math.round(Number($('q-waitMin').value) * 60000),
      maxStages: Number($('q-maxStages').value),
      coldAutoLimit: Number($('q-cold').value),
      affinityGood: Number($('q-good').value),
      affinityBad: Number($('q-bad').value),
      replyMode: $('q-replyMode').value,
    }})
  });
  flash(el, r.ok, r.ok ? '已保存并生效' : ('保存失败：' + r.error));
  if (r.ok) kDirty(false);
  if (r.ok) renderQuest();
}

// ⚠️ 2026-09-15 晚：「替换下次二级事件」**按群存**（<主人>：「最好也加个群选择…
//    因为每个群的故事线不一样」）。所以这里必须把「发到哪个群」那个选择器的值带上 ——
//    不传的话存的是"全局兜底"那份（老页面会那样），界面文案也会说清是哪个群。
async function questSaveHint() {
  const el = $('msg-quest2');
  const gid = String($('q-group')?.value || '').trim();
  if (!gid) { flash(el, false, '先在「发到哪个群」里选一个群（每个群各存各的）'); return; }
  const r = await api('/api/quest/hint', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text: $('q-hint').value, groupId: gid })
  });
  flash(el, r.ok,
    r.ok
      ? (r.nextHint ? `记住了：群 ${gid} 下次自动开剧情时用这句` : `群 ${gid} 那句已清空`)
      : ('失败：' + r.error));
  renderQuest();
}

// ── 「立即开始剧情」发到哪个群（2026-09-15 补）──
// ⚠️ 起因：<主人>「我手动开剧情，699开头的群没启动」。
//    查日志：`管理界面手动开了一条剧情 → 群 200000002` —— 那个按钮**压根没传 groupId**，
//    服务端只能退回 `groups[0]`（配置里第一个 1 档群），所以想开在 699 也会开在 621。
//    现在界面上明确列出 1 档群让人选，并且记住上次选的（localStorage）。
function eventGroupIds() {
  const c = (STATE && STATE.config) || {};
  const trig = c.trigger || {};
  const lv = trig.groupRespondTo || {};
  const allow = (trig.allowGroups || []).map(String);
  return Object.keys(lv)
    .filter((g) => Number(lv[g]) === 1 && (!allow.length || allow.includes(g)))
    .sort();
}

function fillQuestGroup() {
  const gids = eventGroupIds();
  // ⚠️ 两个下拉框共用同一份 1 档群名单：
  //    `q-group`  = 开新剧情发到哪个群
  //    `qc-group` = 正在跑的那条剧情，操作哪个群
  for (const id of ['q-group', 'qc-group']) {
    const sel = $(id);
    if (!sel) continue;
    const keep = sel.value || localStorage.getItem(id) || '';
    sel.innerHTML = gids.length
      ? gids.map((g) => `<option value="${esc(g)}">${esc(groupLabel(g))}</option>`).join('')
      : '<option value="">（现在没有 1 档群）</option>';
    if (keep && gids.includes(keep)) sel.value = keep;
  }
}

// ── 真剧情控制：推进下一段 / 收尾（2026-09-15 晚 <主人>：「也和模拟一样也加一套剧情控制按钮」）──
// `noReply = true` → 不把上面那个框里的话当成群友发言（＝模拟面板的「不发话，直接推进一段」）；
// `forceEnd` = 'good' / 'bad' → 强制收尾（跟模拟面板那两颗按钮一个意思）。
// ⚠️ 服务端会**真的发到群里**，并且真的结算好感度（好结局 +N / 坏结局 −N）。
async function questNext(noReply, forceEnd) {
  const el = $('msg-quest4');
  const gid = String($('qc-group')?.value || '').trim();
  if (!gid) { flash(el, false, '先选一个群（只有 1 档群会进事件系统）'); return; }
  const reply = noReply ? '' : String($('qc-reply')?.value || '').trim();
  const what = forceEnd ? `收尾（${forceEnd === 'good' ? '好' : '坏'}结局）` : '推进下一段';
  if (
    !confirm(
      `对群 ${gid} ${what}？\n\n` +
        `这会**真的往群里发一条**（要几秒生成）。` +
        (reply ? `\n会先当成"群里有人说了「${reply}」"。` : '') +
        (forceEnd ? `\n⚠️ 收尾会按${forceEnd === 'good' ? '好' : '坏'}结局**结算好感度**。` : '') +
        `\n\n确定吗？`,
    )
  ) {
    return;
  }
  const card = el?.closest('.card');
  card?.querySelectorAll('button').forEach((b) => { b.disabled = true; });
  flash(el, null, `正在写${forceEnd ? '结局那一段' : '下一段'}…（要几秒）`);
  try {
    const r = await api('/api/quest/next', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: gid, reply, forceEnd: forceEnd || null }),
    });
    if (!r.ok) { flash(el, false, '失败：' + (r.error || '')); return; }
    if (reply) $('qc-reply').value = '';
    flash(el, true,
      `${forceEnd ? '收尾了' : '已推进'}：群 ${gid} 第 ${r.status?.stage ?? '?'} 段` +
        (r.ending ? `（${r.ending === 'good' ? '好' : '坏'}结局）` : ''));
  } finally {
    card?.querySelectorAll('button').forEach((b) => { b.disabled = false; });
    renderQuest();
  }
}

async function questStartNow() {
  const el = $('msg-quest2');
  const btn = $('btn-q-now');
  const gid = String($('q-group')?.value || '').trim();
  if (!gid) { flash(el, false, '没有 1 档群可选（只有 1 档群进事件系统，先去「活跃度」改档位）'); return; }
  if (!confirm(`这会**真的**往群 ${gid} 发一条剧情，而且它会开始等群友回话（最多跑几小时）。\n\n确定吗？`)) return;
  btn.disabled = true;
  flash(el, null, `正在给群 ${gid} 生成开场…`);
  try {
    const r = await api('/api/quest/start', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      // ⚠️ groupId **必须带上** —— 不带的话服务端只会退回 groups[0]（配置里第一个 1 档群），
      //    于是"想开在 699，结果开在 621"（<主人> 2026-09-15 踩到）
      body: JSON.stringify({ text: $('q-hint').value, groupId: gid })
    });
    flash(el, r.ok, r.ok ? `已发到群 ${r.groupId}：${r.text}` : ('失败：' + r.error));
  } finally {
    btn.disabled = false;
    renderQuest();
  }
}

// ── 清空剧情 / 故事线（测试用，2026-09-15 晚加）──
// <主人>：「加一个清空上次故事的按钮吧，现在还在测试中」
//   `all=true` → 所有群；否则只清「发到哪个群」里选中的那个。
//   ⚠️ 服务端走的是 `quest.abort()`（**不写结局、不动好感度**）+ `storyline.clear()`，
//      别拿"正常收尾"去凑合 —— 那会改好感度、还会往她记忆里写一条假结局。
async function questReset(all) {
  const el = $('msg-quest3');
  const gid = all ? '' : String($('q-group')?.value || '').trim();
  if (!all && !gid) { flash(el, false, '先在「发到哪个群」里选一个群（或者点"清空所有群"）'); return; }
  const what = all ? '所有群' : `群 ${gid}`;
  if (!confirm(`清空${what}的剧情和故事线？\n\n· 正在跑的剧情会被**中止**（不写结局、不动好感度）\n· 故事线历史**删掉就找不回来**\n· 这个群的「本周开过几条」清零\n\n确定吗？`)) return;
  const r = await api('/api/quest/reset', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ groupId: gid }),
  });
  if (!r.ok) { flash(el, false, '失败：' + (r.error || '')); return; }
  flash(el, true, `清完了：中止 ${(r.stopped || []).length} 条剧情，清掉 ${r.groups ?? 0} 个群的故事线`);
  renderQuest();
  if (typeof renderStoryline === 'function') renderStoryline();
  if (typeof renderGroupParams === 'function') renderGroupParams();
}

// ── 剧情模拟（沙箱）──

function renderSim(s) {
  const panel = $('sim-panel');
  const box = $('sim-reply-box');
  const story = $('sim-story');
  if (!panel) return;
  if (!s || !s.premise) {
    panel.innerHTML = '<p class="hint">还没开始模拟。</p>';
    if (box) box.classList.add('hidden');
    if (story) story.innerHTML = '';
    return;
  }
  panel.innerHTML = kv('起因', esc(s.premise)) +
    kv('进度', `第 ${s.stage} 段 / 计划 ${s.plannedStages} 段`) +
    (s.transcript || []).map((x) => {
      if (x.role === 'saki') {
        return `<div style="padding:6px 0;border-bottom:1px dashed var(--line)">
          <b style="color:#5b7fd4">Saki（第 ${x.stage} 段）</b>　${esc(x.text)}
          ${x.event ? `<div style="color:#6b7280;font-size:13px">（世界：${esc(x.event)}）</div>` : ''}</div>`;
      }
      if (x.role === 'skip') {
        return `<div style="padding:4px 0;color:#d97706;font-size:13px">⚠️ 「${esc(x.text)}」被判成<span class="mono">${esc(x.why || '')}</span>，<b>不会影响剧情</b>（真实群里也是这样）</div>`;
      }
      return `<div style="padding:4px 0;color:#16a34a;font-size:13px">${esc(x.name)}：${esc(x.text)}　<span class="mono">(${esc(x.why || '')})</span></div>`;
    }).join('');
  if (box) box.classList.toggle('hidden', !!s.ended);
  if (story) {
    story.innerHTML = (s.story && s.story.length)
      ? '<h2 style="font-size:14px">这次模拟写下的故事线</h2><div class="kvs">' +
        s.story.map((e) => `<div style="padding:3px 0;font-size:13px">${e.tier === 2 ? '【主线】' : ''}${esc(e.text)}</div>`).join('') +
        '</div>'
      : '';
  }
}

async function simStart(custom) {
  const el = $('msg-sim');
  const text = custom ? $('qs-seed').value.trim() : '';
  if (custom && !text) return flash(el, false, '先在框里写一句，或者点左边的"自动生成"');
  flash(el, null, '正在生成…');
  const r = await api('/api/quest/sim/start', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ text })
  });
  flash(el, r.ok, r.ok ? '开始跑了，接着在下面模拟群友说话' : ('失败：' + r.error));
  renderSim(r);
}

async function simNext(silent, forceEnd) {
  const el = $('msg-sim');
  const reply = silent ? '' : $('qs-reply').value.trim();
  // ★ forceEnd：'good' / 'bad' → 这一段强制收尾成那个结局
  flash(el, null, forceEnd ? `正在写成${forceEnd === 'good' ? '好' : '坏'}结局…` : '正在生成下一段…');
  const r = await api('/api/quest/sim/next', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ reply, forceEnd: forceEnd || null })
  });
  if (r.ok) {
    if (!silent) $('qs-reply').value = '';
    flash(el, true, r.done
      // ⚠️ 2026-09-18 修（用户报「模拟收成坏结局，但还是加了好感度」）：
      //    这里原来写死了 `好感度 +${delta}` —— 坏结局的 delta 是**负数**，
      //    显示出来却是「好感度 +-10」，一眼就像"加了"。改成按符号显示。
      ? `剧情结束：${r.ending === 'good' ? '好结局' : '坏结局'}（好感度 ${r.ended ? (r.ended.delta >= 0 ? '+' : '') + r.ended.delta : '?'}）`
      : '已生成下一段');
  } else {
    flash(el, false, '失败：' + r.error);
  }
  renderSim(r);
}

async function simReset() {
  const r = await api('/api/quest/sim/reset', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
  flash($('msg-sim'), true, '已清空模拟');
  renderSim(r);
}

// ── 故事线（**每个群一份**，2026-09-15 <主人> 要求）──
//
// 用户原话：「一个群设一个故事线知识库……知识库调用时一定要分清就行了。
//   然后再做故事线卡片」。
// ⚠️ 界面上**每行都是一个群** —— 压缩/看内容都是按群做的（不许有"全局默认"这种含糊操作）。
let slOpenGroup = '';

async function renderStoryline() {
  const total = $('sl-total');
  const box = $('sl-groups');
  if (!total || !box) return;
  try {
    const r = await api('/api/storyline/state');
    const s = r.status || {};
    total.innerHTML =
      kv('一共几个群', `${s.groups ?? 0} 个（每个群一条独立的世界线）`) +
      kv('全部条数', `${s.total ?? 0} 条，其中锁定 <b style="color:#16a34a">${s.locked ?? 0}</b> 条`) +
      kv('压缩过几次', `${s.compressRuns ?? 0} 次`) +
      kv('存档', `<span class="mono">${esc(s.file || '')}</span>`) +
      (s.lastError ? kv('上次出错', `<b style="color:#d97706">${esc(s.lastError)}</b>`) : '');

    const rows = s.byGroup || [];
    if (!rows.length) {
      box.innerHTML = '<p class="hint">还没有任何群的故事线 —— 等她发第一条日常或剧情就有了。</p>';
      $('sl-entries').innerHTML = '';
      return;
    }
    box.innerHTML = rows.map((g) => `
      <div class="kv">
        <b>群 ${esc(g.groupId)}</b>
        <span>${g.total} 条（锁定 <b style="color:#16a34a">${g.locked}</b>）· ${g.chars} 字 ·
          上次压缩 ${g.lastCompressAt ? new Date(g.lastCompressAt).toLocaleString('zh-CN') : '从没压过'}</span>
        <span style="margin-left:auto;white-space:nowrap">
          <button class="act" onclick="slView('${esc(g.groupId)}')">${slOpenGroup === g.groupId ? '收起' : '看内容'}</button>
          <button class="act" onclick="slCompress('${esc(g.groupId)}')">压缩这个群</button>
        </span>
      </div>`).join('');

    if (slOpenGroup) await slView(slOpenGroup, true);
    else $('sl-entries').innerHTML = '';
  } catch (e) {
    total.innerHTML = `<div class="kv"><b>读取失败</b><span>${esc(e.message)}</span></div>`;
  }
}

/** 展开看某个群的故事线（⚠️ 按群拉，绝不混着看） */
async function slView(groupId, keepOpen) {
  const box = $('sl-entries');
  if (!box) return;
  if (slOpenGroup === groupId && !keepOpen) {
    slOpenGroup = '';
    box.innerHTML = '';
    renderStoryline();
    return;
  }
  slOpenGroup = groupId;
  try {
    const r = await api('/api/storyline/entries?groupId=' + encodeURIComponent(groupId) + '&limit=80');
    const list = r.entries || [];
    box.innerHTML =
      `<h2 style="font-size:14px">群 ${esc(groupId)} 的故事线（${list.length} 条，时间正序）</h2>` +
      (list.length
        ? list.map((e) => `<div class="kv">
            <b>${new Date(e.at).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'})}</b>
            <span>${e.locked ? '<b style="color:#16a34a">[锁定·主线]</b> ' : ''}${esc(e.text)}</span>
            ${(e.tags || []).length ? `<span class="mono" style="margin-left:auto">${esc((e.tags || []).join(' '))}</span>` : ''}
          </div>`).join('')
        : '<p class="hint">（这个群还没有条目）</p>');
    if (!keepOpen) renderStoryline();
  } catch (e) {
    box.innerHTML = `<p class="hint">读取失败：${esc(e.message)}</p>`;
  }
}

/** 压缩**某一个群**（会真的调模型，整次可能作废 —— 失败原因会原样显示出来） */
async function slCompress(groupId) {
  if (!confirm(`压缩群 ${groupId} 的故事线？\n\n（会调一次模型：把流水账改写成「一章一件事」的章节，\n  日期由代码按真实时间加；带「锁定」的主线条目只允许变短，\n  模型想删掉任何一条都会整次作废、一个字都不写）`)) return;
  // ⚠️⚠️ 结果必须写进**独立的提示位**（`#sl-msg`）：
  //    以前写进 `#sl-entries`，而 `renderStoryline()` 结尾正好会重写/清空那个容器
  //    → 用户**看不到"压好了"还是"没压成"**，界面看着就像"点了没反应"（踩过几次）。
  const msg = $('sl-msg');
  msg.innerHTML = `<p class="hint">⏳ 正在压缩群 ${esc(groupId)}…（要十几秒，别关这个页面）</p>`;
  const r = await api('/api/storyline/compress', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ groupId, force: true }),
  });
  if (r.ok) {
    msg.innerHTML = `<p class="hint">✅ 群 ${esc(groupId)} 压缩完成：${r.result.before} → ${r.result.after} 字，
      ${r.result.kept} 条（写成 <b>${r.result.chapters || 0}</b> 章，锁定 ${r.result.locked} 条一条没少）</p>`;
    // ★ 压完**直接展开这个群** —— 用户点一次就要马上看到结果，不用再点「看内容」
    slOpenGroup = String(groupId);
  } else {
    msg.innerHTML = `<p class="hint">❌ 没压成：${esc((r.result && r.result.message) || r.error || '未知原因')}</p>`;
  }
  await renderStoryline();
}

// ── 按群设定（<主人>：「参数也可以分群设定」）──
//
// ⚠️⚠️ 2026-09-16 改造（用户要求）：
//    「把**日常事件的节奏设置**和**二级事件的参数**也加一个**下拉群菜单**分群调节，
//      注意修改的参数**一定要能真正保存**，而且能在 webui 上**马上看到变化**，
//      不同群的数据**一定不要混在一起**了」
//
//   · 下拉选一个群 → 下面整张表单都是**这个群**的（不是一行行平铺所有群）
//   · 每个输入框显示的都是**这个群现在实际生效的值**（没有"跟全局"那一档了）
//   · 保存后**立刻回读**（`fillGroupParams()`）→ 界面马上显示这个群现在生效的值
//   · 后端 config.js 会做白名单 + 数值化，所以"存了不生效"的字符串进不去
//   · 数据不混：life/quest 的参数、计数、排程、故事线**都是按群的**
let gpGroups = [];

/**
 * 2026-10-22 加：群聊剧情页的选群联动。
 *
 * 三个标签（日常事件 / 二级剧情 / 按群参数）各自的第一张卡里都有一个 `.gp-group-sel`，
 * 改任何一个会**同步其余两个**，值统一存 `localStorage['gp-group']`。
 * ⚠️ 为什么不用"顶部一个下拉 + 三个标签共用"：用户说「这个挪到卡片里边，在顶上和别的页面
 *    操作习惯不一致」—— 别的页面（B站）选群都在卡片里，所以选群要落进各自的卡片。
 */
function gpGroupChanged(v, el) {
  try {
    localStorage.setItem('gp-group', v);
  } catch {}
  document.querySelectorAll('.gp-group-sel').forEach((s) => {
    if (s !== el) s.value = v;
  });
  fillGroupParams();
}

/** 群号 → 群名（`renderGroupParams()` 拉的，三个下拉共用） */
const gpNames = new Map();

/**
 * ⚠️ 2026-10-22（用户：「三个地方统一一下写法吧，统一成群+群号+名字」）：
 * 全局统一的下拉文案 —— **群 1234567（群名）**，拿不到名字就只写群号。
 *
 * 三处群下拉原来各写各的（有的连"群"字都没有、有的只有群号）：
 *   · 群聊剧情 → 「群聊选择」
 *   · 群与触发 → 分群灵敏度 →「群聊选择」
 *   · B站 → 分享 →「群聊选择」
 * 现在都走这里。
 */
function groupLabel(gid) {
  const g = String(gid ?? '').trim();
  if (!g) return '';
  const n = gpNames.get(g) || '';
  return n ? `群 ${g}（${n}）` : `群 ${g}`;
}

/** 拉一次群名表（有缓存就不再拉；`force` 可以强制刷新） */
async function ensureGroupNames(force = false) {
  if (!force && gpNames.size) return;
  try {
    const r = await api('/api/qq/groups');
    const list = Array.isArray(r?.groups) ? r.groups : [];
    gpNames.clear();
    for (const g of list) gpNames.set(String(g.id), String(g.name || ''));
  } catch {
    /* 拿不到群名就只显示群号，不影响下拉能用 */
  }
}

/** 生成 `<option>` 列表（三个下拉共用）—— 当前选中的那个打 selected */
function gpOptionsHtml() {
  // ⚠️ 2026-10-22 加固：`gpGroups` 是 `renderGroupParams()` 才填的 ——
  //    如果 `fillGroupParams()` 在它之前跑（或者还没拿到群列表），这里会生成**空的下拉**
  //    （用户截图：「下拉炸了」）。空的时候至少给一条提示，别让用户对着空气点。
  if (!Array.isArray(gpGroups) || !gpGroups.length) {
    return '<option value="">（没有 1 档群）</option>';
  }
  const cur = String(localStorage.getItem('gp-group') || '') || String(gpGroups[0] ?? '');
  return gpGroups
    .map((g) => {
      const isSel = String(g) === cur;
      // ⚠️ 2026-10-22：文案统一走 `groupLabel()`（群 + 群号 + 名字）
      return `<option value="${esc(g)}"${isSel ? ' selected' : ''}>${esc(groupLabel(g))}</option>`;
    })
    .join('');
}

/** 三个标签共用的「哪个群」区块（模板开头插它） */
function gpSelectHtml(scope) {
  return (
    '      <div style="margin-bottom:12px">\n' +
    '        <b>哪个群</b>\n' +
    `        <select class="gp-group-sel" data-scope="${scope}" style="width:auto;margin:0 8px"\n` +
    '          onchange="gpGroupChanged(this.value, this)">${gpOptionsHtml()}</select>\n' +
    '      </div>\n'
  );
}

async function renderGroupParams() {
  // ⚠️ 2026-10-22：不再有固定的 `#gp-group` —— 三个标签各有自己的 `.gp-group-sel`，
  //    选项由 `gpOptionsHtml()` 在 `fillGroupParams()` 里生成。这里只拉群列表/群名 + 顶部状态行。
  const box = $('gp-head');
  if (!box) return;
  try {
    // ⚠️ 2026-10-06 加（用户：「分群调节那里要能**显示群名称**，现在有点不方便」）：
    //    下拉里光有群号认不出是哪个群 ⇒ 顺便把**群名**也拉回来
    //    （`GET /api/qq/groups` 本来就返回 `{id, name, count}`，只是这一页之前没用）。
    //    ⚠️ 取不到就退回只显示群号，别让整页读不出来。
    // ⚠️⚠️ 2026-10-16 修（用户：「**按群设定读取不到还没修好**」）——
    //    原来这三个是 `Promise.all` 一起 await ⇒ **只要有一个失败，整页就废** ✗
    //    实测：机器人跟协议端"半死"的那一两分钟（日志里全是「心跳」超时）里，
    //    `/api/state` 拿不到 → 整页只剩一句含糊的 `读取失败：Unexpected end of JSON input`，
    //    用户根本看不出来"是机器人掉线了、等会儿刷新就好"✗
    //    ⇒ 现在：`/api/storyline/state`、`/api/qq/groups` 各自容错（拿不到就少显示一点），
    //      只有 `/api/state`（群列表的来源）真失败才报错，而且报的是**人话** ✓
    const [stR, slR, gqR] = await Promise.allSettled([
      api('/api/state'),
      api('/api/storyline/state'),
      api('/api/qq/groups'),
    ]);
    if (stR.status !== 'fulfilled' || !stR.value) {
      const why = stR.status === 'rejected' ? String(stR.reason?.message ?? '') : '空的';
      box.innerHTML =
        '<p class="hint">⚠️ 这会儿**读不到机器人的群列表** —— 多半是它刚跟协议端断开、正在重连' +
        `（日志里会有一串「心跳」超时）。<br>⚠️ 原始报错：${esc(why)}<br>` +
        '等 5 秒，然后点下面这个按钮再读一次就行，**不用重启**。<br>' +
        '<button class="ghost" onclick="renderGroupParams()">重新读一次</button></p>';
      return;
    }
    const st = stR.value;
    const sl = slR.status === 'fulfilled' ? slR.value : null;
    const gq = gqR.status === 'fulfilled' ? gqR.value : null;
    const nameOf = new Map(
      ((gq && gq.groups) || []).map((g) => [String(g.id), String(g.name || '')]),
    );
    // ⚠️ 2026-10-22：存一份给 `gpOptionsHtml()`（三个标签的选群下拉要用群名）
    nameOf.forEach((v, k) => gpNames.set(k, v));
    /** 群号 + 群名（取不到名字就只给号） */
    const labelOf = (g) => {
      const n = nameOf.get(String(g)) || '';
      return n ? `群 ${g}（${n}）` : `群 ${g}`;
    };
    const lv = (st.config && st.config.trigger && st.config.trigger.groupRespondTo) || {};
    const allow = ((st.config && st.config.trigger && st.config.trigger.allowGroups) || []).map(String);
    const inSl = ((sl && sl.status && sl.status.byGroup) || []).map((x) => String(x.groupId));
    // ⚠️⚠️ **只有 1 档群才进事件系统**（<主人> 2026-09-15：
    //    「挡位 2 不能进事件系统，只有 1 才能设置」）—— 所以下拉里**只有 1 档群**。
    const isEvent = (g) => Number(lv[g]) === 1 && (!allow.length || allow.includes(g));
    const all = [...new Set([...Object.keys(lv), ...inSl])];
    gpGroups = all.filter(isEvent).sort();
    const skipped = all.filter((g) => !isEvent(g)).sort();
    if (!gpGroups.length) {
      box.innerHTML =
        '<p class="hint">现在<b>没有 1 档群</b> —— 只有 1 档群才进事件系统（日常事件 + 剧情）。' +
        (skipped.length ? `<br>不在事件系统里的群：${skipped.map(esc).join('、')}` : '') +
        '<br>先去「活跃度」把要跑事件的群改成 <b>1 档</b>。</p>';
      return;
    }
    // ⚠️ 2026-10-22：选群下拉的选项由 `gpOptionsHtml()`（在 fillGroupParams 里）生成 ——
    //    这里只需要保证 localStorage 里那个群还在列表里，不在就退回第一个。
    const keep = String(localStorage.getItem('gp-group') || '');
    try {
      localStorage.setItem('gp-group', gpGroups.includes(keep) ? keep : gpGroups[0]);
    } catch {}
    // ⚠️ 2026-10-22 删掉（用户：「这个不用说」）：原来在这里列一串
    //    "群 xxx 现在不在事件系统里" —— 那个列表又长又全是群号，占满一行还没信息量。
    //    下拉里本来就只列能设置的群，看不到的群自然就选不到。
    // ⚠️ 2026-10-22：三个标签的选群下拉是**静态 HTML**（`class="gp-group-sel"`），
    //    选项在这里统一填 —— 不填的话它们永远只有一个空 `▼`（用户截图：「下拉炸了」）。
    document.querySelectorAll('.gp-group-sel').forEach((sel) => {
      sel.innerHTML = gpOptionsHtml();
      const keepGid = String(localStorage.getItem('gp-group') || '');
      if (keepGid) sel.value = keepGid;
    });
    await fillGroupParams();
  } catch (e) {
    // ⚠️ 2026-10-16：这里要报"人话"，别把 `Unexpected end of JSON input` 甩给用户 ✗
    const msg = String(e?.message ?? '');
    const netish = /JSON|Failed to fetch|NetworkError|timeout|超时|断开|连接/i.test(msg);
    box.innerHTML =
      '<p class="hint">' +
      (netish
        ? '⚠️ 这会儿**读不到机器人状态** —— 多半是它刚跟协议端断开、正在重连。' +
          '<br>等 5 秒再点一次下面那个按钮就行，**不用重启**。'
        : '读取失败：' + esc(msg)) +
      `<br>⚠️ 原始报错：${esc(msg)}<br>` +
      '<button class="ghost" onclick="renderGroupParams()">重新读一次</button></p>';
  }
}

/** 选中群的表单（**框里就是这个群现在实际生效的值**，没有"跟全局"） */
async function fillGroupParams() {
  const box = $('gp-head');
  // ⚠️ 2026-10-22 兜底（用户截图：「下拉炸了」）：localStorage 里还没值时用 gpGroups[0]。
  //    否则第一次进页面 `gid` 是空 ⇒ 这里直接 return ⇒ 三个容器一个都不渲染。
  const gid = String(
    document.querySelector('.gp-group-sel')?.value ||
    localStorage.getItem('gp-group') ||
    gpGroups[0] ||
    '',
  ).trim();
  if (!box) return;
  if (!gid) {
    box.innerHTML = '';
    return;
  }
  box.innerHTML = '<p class="hint">读取中…</p>';
  let r;
  try {
    r = await api(`/api/group-params?groupId=${encodeURIComponent(gid)}`);
  } catch (e) {
    box.innerHTML = `<p class="hint">读取失败：${esc(e.message)}</p>`;
    return;
  }
  if (!r.ok) {
    box.innerHTML = `<p class="hint">读取失败：${esc(r.error || '')}</p>`;
    return;
  }
  const ov = r.overrides || {};
  const p = r.params || {};
  const L = p.life || {};
  const Q = p.quest || {};
  const C = p.chat || {};
  const B = p.biliShare || {};
  const shareStatus = r.biliShareStatus || {};
  const oL = ov.life || {};
  const oQ = ov.quest || {};
  const oC = ov.chat || {};
  // ⚠️ 2026-10-05：同类池（按群，一串 QQ 号）—— 它是**顶层**字段，不在 life/quest/chat 里。
  const peers = Array.isArray(ov.peers) ? ov.peers : [];
  // ⚠️ 2026-10-06：不同类池（同样是顶层的一串 QQ 号）—— 和同类池**正好相反**。
  const otherBots = Array.isArray(ov.otherBots) ? ov.otherBots : [];
  // ⚠️⚠️ 2026-09-16（用户要求）：「还是有跟全局的选项」「默认选关闭就行了」——
  //    **彻底去掉"跟全局"这个概念**：每个群就是**自己完整的一份**。
  //    所以这里所有输入框显示的都是**这个群现在实际生效的值**，
  //    开关只有「开 / 关」两态（不再有第三档"跟全局"）。
  const val = (v) => (v === undefined || v === null ? '' : esc(String(v)));
  /** 开 / 关 两态（值 = 这个群现在实际生效的那个状态） */
  const onoff = (id, on) =>
    `<select id="${id}" class="wauto-m0">
       <option value="1"${on ? ' selected' : ''}>开</option>
       <option value="0"${on ? '' : ' selected'}>关</option>
     </select>`;
  const mins = (ms) => (Number.isFinite(Number(ms)) ? String(Math.round(Number(ms) / 60000)) : '');

  // 今天这个群的进度（"马上看到变化"）
  let today = '';
  try {
    const s = await api(`/api/life/status?groupId=${encodeURIComponent(gid)}`);
    if (s?.ok && s.status) {
      const nx = s.status.nextAt ? new Date(s.status.nextAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—';
      today = `今天 <b>${s.status.fired}/${s.status.target}</b> 条 · 下次约 ${nx} · 时段 ${esc(s.status.window)}`;
    }
  } catch {}

  // ⚠️ 2026-10-22 删（用户：「这玩意不是和这个重了吗」）：
  //    这里原来写一行「群 xxx · 今天 2/5 条 · 下次约 — · 时段 7:00-24:00 · 改完保存只影响这个群」，
  //    和下面「日常事件」卡里的状态列表（今天 / 下次大概 / 允许时段）**完全重复**。
  //    `#gp-head` 现在只留给**出错信息**（上面几个 catch 分支会写它），正常情况下是空的。
  box.innerHTML = '';
  // ⚠️ 2026-10-22 拆（用户：「拆吧，一整套」）：参数跟着功能走。
  const lifeBox = $('gp-life-params');
  const questBox = $('gp-quest-params');
  const botsBox = $('gp-bots-params');
  if (lifeBox)
    lifeBox.innerHTML = `    <div style="margin-bottom:14px">
      <!-- ⚠️ 2026-10-22 删标题（用户：「把日常事件（一级）这四个字删掉」）——
           pagehead 已经写了「日常事件（一级）」，块里再写一遍是重复。 -->
      <div class="kv" style="flex-wrap:wrap;gap:8px;margin-top:6px">
        <label>这个群收日常事件 ${onoff('gp-life-enable', L.enable !== false)}</label>
        <label title="节日会换事件池、放假屏蔽「上课/赶电车」">节日生效 ${onoff('gp-life-holidays', L.holidays !== false)}</label>
        <label title="每天最少几条">每天最少 <input type="number" id="gp-life-min" min="1" max="20" style="width:70px" value="${val(L.minPerDay)}"></label>
        <label title="每天最多几条">每天最多 <input type="number" id="gp-life-max" min="1" max="20" style="width:70px" value="${val(L.maxPerDay)}"></label>
        <label title="从几点开始允许发（0-7 点不发）">几点开始 <input type="number" id="gp-life-sh" min="0" max="23" style="width:70px" value="${val(L.startHour)}"></label>
        <label title="到几点（24 = 到午夜）">几点结束 <input type="number" id="gp-life-eh" min="1" max="24" style="width:70px" value="${val(L.endHour)}"></label>
        <label title="两条之间最少隔多久">间隔（分钟） <input type="number" id="gp-life-cool" min="1" style="width:80px" value="${mins(L.cooldownMs)}"></label>
        <label title="错过多久就不补发">迟到容忍（分钟） <input type="number" id="gp-life-late" min="0" style="width:80px" value="${mins(L.lateToleranceMs)}"></label>
      </div>
    </div>
      <div class="btns mt10">
        <button class="act" onclick="saveLifeParams()">保存这个群的日常事件参数</button>
        <span class="msg" id="msg-gp-life"></span>
      </div>`;
  if (questBox)
    questBox.innerHTML = `    <div style="margin-bottom:14px">
      <b>二级剧情</b>
      <div class="kv" style="flex-wrap:wrap;gap:8px;margin-top:6px">
        <label title="⚠️ 关掉 = **屏蔽**这个群的 /剧情 和 /清除剧情（同一个群里跑两个机器人时，用它避免两边抢）。默认开着"><b>接收 /剧情 命令</b> ${onoff('gp-quest-commands', Q.commands !== false)}</label>
        <label>这个群自动开剧情 ${onoff('gp-quest-enable', Q.enable === true)}</label>
        <label title="一级事件攒到点时，掷骰子自动开一条剧情的概率">概率 <input type="number" id="gp-quest-chance" min="0" max="1" step="0.01" style="width:70px" value="${val(Q.chance)}"></label>
        <label title="每 7 天最多几条">每周上限 <input type="number" id="gp-quest-max" min="1" max="20" style="width:70px" value="${val(Q.maxPerWeek)}"></label>
        <label title="每段等群友多久">每段等待（分钟） <input type="number" id="gp-quest-wait" min="1" style="width:80px" value="${mins(Q.waitMs)}"></label>
        <label title="硬上限段数">最多段数 <input type="number" id="gp-quest-stages" min="1" max="10" style="width:70px" value="${val(Q.maxStages)}"></label>
        <label title="没人回最多自动续几段">冷场自动续 <input type="number" id="gp-quest-cold" min="0" max="5" style="width:70px" value="${val(Q.coldAutoLimit)}"></label>
        <label title="群友哪句话才算「能改变剧情」">谁的话算数
          <select id="gp-quest-mode" class="wauto-m0">
            <option value="strict"${Q.replyMode === 'strict' ? ' selected' : ''}>严格（只认@她/回她/明显的建议）</option>
            <option value="normal"${(Q.replyMode ?? 'normal') === 'normal' ? ' selected' : ''}>标准（+任何问句）</option>
            <option value="loose"${Q.replyMode === 'loose' ? ' selected' : ''}>宽松（+6字以上闲聊）</option>
          </select>
        </label>
        <label title="好结局加多少好感度">结局好感 + <input type="number" id="gp-quest-good" min="0" max="10" style="width:70px" value="${val(Q.affinityGood)}"></label>
        <label title="坏结局扣多少（负数）">结局好感 − <input type="number" id="gp-quest-bad" min="-10" max="0" style="width:70px" value="${val(Q.affinityBad)}"></label>
      </div>
    </div>
      <div class="btns mt10">
        <button class="act" onclick="saveQuestParams()">保存这个群的剧情参数</button>
        <span class="msg" id="msg-gp-quest"></span>
      </div>`;
  if (botsBox)
    botsBox.innerHTML = `    <div style="margin-bottom:14px">
      <b>机器人同类池</b>
      <div class="hint" style="margin:4px 0">
        填 QQ 号，<b>一行一个</b>（逗号/空格也认）。填进去的<b>直接当同类机器人</b>：
        她不再把它当"要忽略的机器人"（它说话她会正常接），上下文里也会标出来
        —— 别把它的话当成她自己说的。<br>
        ⚠️ 跟「群与触发」里那个「能在哪些群说话」不是一回事：那个填的是<b>群号</b>，这里填的是<b>人的 QQ 号</b>。
      </div>
      <textarea id="gp-peers" rows="3" placeholder="填同类机器人的 QQ 号" style="width:100%">${esc(peers.join('\n'))}</textarea>
      <div style="margin-top:6px">
        ⚠️ 下面两个按钮**跳过冷场/冷却那几道时间闸**（就是想马上看到效果），点一次真发一次：
        <button class="act" onclick="peerChatNow(false)">立刻试一次（@ 它说一句）</button>
        <button class="act" onclick="peerChatNow(true)">立刻试一次（戳它一下）</button>
      </div>
    </div>

    <div style="margin-bottom:14px">
      <b>不同类机器人池</b>
      <div class="hint" style="margin:4px 0">
        填 QQ 号，<b>一行一个</b>（逗号/空格也认）。填进去的<b>她一个字都不回</b> ——
        连 @ 她、引用她也不回，也不进剧情和好感度。<br>
        专门放<b>别的机器人</b>（小豆那种）：<b>和上面那个同类池正好相反</b> ——
        同类池是"要跟它聊的"，这个池是"当它不存在的"。<br>
        ⚠️ 同一个号两个池都填 → 按"完全不回应"处理（日志里会提醒你一声）。
      </div>
      <textarea id="gp-other-bots" rows="3" placeholder="填不要理会的机器人 QQ 号" style="width:100%">${esc(otherBots.join('\n'))}</textarea>
    </div>
    <!-- ⚠️ 2026-10-22 拆的时候把这段保存栏搞丢了（foot 的边界算错）→ 补回来：
         「恢复内置起点」清的是**整个群**的覆盖（事件/剧情/池子一起），所以放在这一页最底下。 -->
    <div class="btns mt10">
      <button class="act" onclick="saveBotsParams()">保存机器人池</button>
      <button class="act" onclick="clearGroupParams()">恢复内置起点</button>
      <span class="msg" id="msg-gp-bots"></span>
    </div>
    <!-- ⚠️ 2026-10-22 清掉：这里原来有「这个群现在：日常事件 关（每天 3~10 条…）· 自动开剧情…」
         + 「这个群单独设过：{一大段 JSON}」。前者那些参数已经拆回各自标签、重复了；
         后者是开发者调试用的，用户看不懂。 -->
    <div class="hint mt6">
      ⚠️「恢复内置起点」= 把这个群<b>所有</b>按群设置清掉（事件 / 剧情 / 机器人池一起），回到内置起点（<b>不是</b>回到别的群）。
    </div>
`;
}

/**
 * ⚠️ 2026-10-05 加：手动触发一次「同类机器人搭话」（跳过冷场/冷却那几道时间闸）。
 * ⚠️ 它**会真的发到群里**，而且照样记账（冷却该算）。
 */
async function peerChatNow(poke) {
  const gid = String(localStorage.getItem('gp-group') || '').trim();
  if (!gid) return alert('先在上面选一个群');
  try {
    const r = await api('/api/peer-chat/now', {
      method: 'POST',
      body: JSON.stringify({ groupId: gid, poke: !!poke }),
    });
    if (!r?.ok) return alert(`没成：${r?.error || '不知道为啥'}`);
    alert(r.poke ? `戳了「${r.name}」一下（去群里看）` : `说了：「${r.text}」`);
  } catch (e) {
    alert(`出错：${e.message}`);
  }
}

// ⚠️ 2026-10-22 删掉 `saveGroupParams()`：拆成 saveLifeParams / saveQuestParams / saveBotsParams 之后，
//    它已经没有调用点了（三个标签各自提交自己那段）。留着的话有人会误以为它还在用。

async function saveLifeParams() {
  const gid = String(localStorage.getItem('gp-group') || '').trim();
  if (!gid) return;
  const btn = event?.target;
  if (btn) btn.disabled = true;
  const r = await api('/api/group-params', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groupId: gid,
      patch: {
        life: {
          enable: _gpBool('gp-life-enable'),
          holidays: _gpBool('gp-life-holidays'),
          minPerDay: _gpNum('gp-life-min'),
          maxPerDay: _gpNum('gp-life-max'),
          startHour: _gpNum('gp-life-sh'),
          endHour: _gpNum('gp-life-eh'),
          cooldownMs: _gpMin('gp-life-cool'),
          lateToleranceMs: _gpMin('gp-life-late'),
        },
      },
    }),
  });
  if (btn) btn.disabled = false;
  flash($('msg-gp-life'), r.ok, r.ok ? `已保存到群 ${gid}` : '保存失败：' + (r.error || ''));
  if (r.ok) await fillGroupParams();
}

async function saveQuestParams() {
  const gid = String(localStorage.getItem('gp-group') || '').trim();
  if (!gid) return;
  const btn = event?.target;
  if (btn) btn.disabled = true;
  const r = await api('/api/group-params', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groupId: gid,
      patch: {
        quest: {
          commands: _gpBool('gp-quest-commands'),
          enable: _gpBool('gp-quest-enable'),
          chance: _gpNum('gp-quest-chance'),
          maxPerWeek: _gpNum('gp-quest-max'),
          waitMs: _gpMin('gp-quest-wait'),
          maxStages: _gpNum('gp-quest-stages'),
          coldAutoLimit: _gpNum('gp-quest-cold'),
          affinityGood: _gpNum('gp-quest-good'),
          affinityBad: _gpNum('gp-quest-bad'),
          replyMode: (() => {
            const v = String($('gp-quest-mode')?.value ?? '');
            return v === '' ? null : v;
          })(),
        },
      },
    }),
  });
  if (btn) btn.disabled = false;
  flash($('msg-gp-quest'), r.ok, r.ok ? `已保存到群 ${gid}` : '保存失败：' + (r.error || ''));
  if (r.ok) await fillGroupParams();
}

async function saveBotsParams() {
  const gid = String(localStorage.getItem('gp-group') || '').trim();
  if (!gid) return;
  const btn = event?.target;
  if (btn) btn.disabled = true;
  const split = (id) =>
    String($(id)?.value ?? '')
      .split(/[\s,，、]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  const r = await api('/api/group-params', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groupId: gid,
      patch: { peers: split('gp-peers'), otherBots: split('gp-other-bots') },
    }),
  });
  if (btn) btn.disabled = false;
  flash($('msg-gp-bots'), r.ok, r.ok ? `已保存到群 ${gid}` : '保存失败：' + (r.error || ''));
  if (r.ok) await fillGroupParams();
}

async function clearGroupParams() {
  const gid = String(localStorage.getItem('gp-group') || '').trim();
  if (!gid) return;
  if (!confirm(`把群 ${gid} 的设置清掉，回到**内置起点**？\n\n（不是回到别的群 —— 每个群各是各的）`)) return;
  const r = await api('/api/group-params', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      groupId: gid,
      patch: {
        life: {
          enable: null,
          holidays: null,
          minPerDay: null,
          maxPerDay: null,
          startHour: null,
          endHour: null,
          cooldownMs: null,
          lateToleranceMs: null,
        },
        quest: {
          enable: null,
          chance: null,
          maxPerWeek: null,
          waitMs: null,
          maxStages: null,
          coldAutoLimit: null,
          affinityGood: null,
          affinityBad: null,
          replyMode: null,
        },
        chat: { strictness: null },
        biliShare: null,
      },
    }),
  });
  if (!r.ok) return alert('失败：' + (r.error || ''));
  await fillGroupParams();
}

async function biliShareNow() {
  const gid = String(localStorage.getItem('gp-group') || '').trim();
  if (!gid) return alert('先在上面选一个群');
  if (!confirm(`立即向群 ${gid} 发送一个 B 站视频链接？`)) return;
  try {
    const r = await api('/api/bili-share/send-now', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: gid }),
    });
    if (!r?.ok) return alert(`发送失败：${r?.error || '未知错误'}`);
    alert(`已发送到群 ${gid}：${r.title || r.url}`);
    await fillGroupParams();
  } catch (e) {
    alert(`发送失败：${e.message}`);
  }
}

// ── 好感度 / 好友 ──
/**
 * 2026-10-22 新增：好友名单 —— 从 `renderAffinity()` 里抽出来的。
 *
 * ⚠️ 为什么必须抽：那张卡挪到了「群与触发 → 私聊」，而 `renderAffinity()` 一进 groups 页
 *    就在开头 `if (!el) return;`（`aff-status` 不在那儿）⇒ 永远填不到好友名单。
 */
async function loadFriendList() {
  const el = $('f-list');
  if (!el) return;
  el.textContent = '加载中…';
  try {
    const r = await api('/api/friend/state');
    const s = r.status || {};
    const cfg = r.config || {};
    // ⚠️ 2026-10-22：这几个字段的填值从 `renderAffinity()` 搬过来 ——
    //    「到线通知 / 主动私聊」的控件跟着卡片挪到了这一页，那边再填就是 null 报错。
    //    ⚠️ 填完不要丢：这张卡一进来就是空的，用户会以为"没配过"。
    if ($('f-dm-enable')) $('f-dm-enable').checked = cfg.dmEnable !== false;
    if ($('f-chance')) $('f-chance').value = cfg.dailyChance ?? 0.35;
    if ($('f-from')) $('f-from').value = cfg.dayFromHour ?? 9;
    if ($('f-to')) $('f-to').value = cfg.dayToHour ?? 22;
    if ($('f-gapHours')) $('f-gapHours').value = Math.round((cfg.minGapMs ?? 72000000) / 3600000);
    const list = s.friendList || [];
    const nm = (x) =>
      `${esc(x.name || '（还没说过话）')} <span class="mono" style="opacity:.55">${esc(x.userId)}</span>`;
    el.innerHTML = list.length
      ? list
          .map(
            (f) =>
              `<div class="kv"><span>${nm(f)}</span><span style="margin-left:auto">好感度 ${f.score}　${f.lastDmAt ? '上次私聊 ' + new Date(f.lastDmAt).toLocaleDateString('zh-CN') : '还没私聊过'}</span></div>`,
          )
          .join('')
      : '<div class="hint">还没有好友加进来。<br>（⚠️ 协议层发不了加好友申请，所以是"到线时在群里 @ 他、让他来加"。）</div>';
  } catch (e) {
    el.textContent = '出错：' + e.message;
  }
}

async function renderAffinity() {
  const el = $('aff-status');
  if (!el) return;
  try {
    // ⚠️ 好感度**按群**（2026-09-15 晚）：带上选中的群号；顺手把群列表填进下拉框
    const gid = String($('aff-group')?.value || '').trim();
    const r = await api('/api/friend/state' + (gid ? `?groupId=${encodeURIComponent(gid)}` : ''));
    const c = r.config || {};
    const s = r.status || {};
    {
      const sel = $('aff-group');
      if (sel) {
        const gids = Array.isArray(r.groups) && r.groups.length ? r.groups : [];
        const keep = gid;
        sel.innerHTML = ['<option value="">（全部 / 老数据）</option>']
          .concat(gids.map((g) => `<option value="${esc(g)}">${esc(groupLabel(g))}</option>`))
          .join('');
        sel.value = keep && gids.includes(keep) ? keep : '';
      }
    }
    $('a-threshold').value = c.friendThreshold ?? 90;
    // ⚠️ 2026-09-30：回填时把「收回」钳在「门槛」之下。配置侧也夹过一次
    //    （config.js），这里是**界面侧**的第二道 —— 免得用户填了 90/70 之后
    //    看着两个框都是"合法值"，实际那档只开不关却毫无提示。
    const _unlock = Number(c.sensitiveUnlock) || 70;
    $('a-unlock').value = _unlock;
    $('a-retract').value = Math.min(_unlock - 1, Number(c.sensitiveRetract) || 60);
    $('a-boardSize').value = c.boardSize ?? 10;
    $('a-window').value = Math.round((c.interactWindowMs ?? 1800000) / 60000);
    // ⚠️ 2026-10-22：「到线通知」拆回来放这一页了（开关 + 模板）——
    //    它跟"加好友门槛"是一套逻辑（到线了才通知），放一起才对。
    //    ⚠️ 主动私聊的参数（概率/时段/间隔）在「群与触发 → 私聊」，不在这里，别加回来。
    if ($('f-notice-enable')) $('f-notice-enable').checked = c.noticeEnable !== false;
    if ($('f-notice')) $('f-notice').value = c.notice ?? '';

    const sc = r.scores || {};
    // ⚠️ 2026-10-22：删掉「加好友门槛」和「群里放松说话门槛」两行（用户截图圈了）。
    //    它们和下面「参数」卡里的两个输入框**重复**，而且这里只读、改不了 —— 看着像状态，
    //    其实是参数，容易让人以为"这里显示的改不了"。
    el.innerHTML =
      kv('有记录的人数', sc.count ?? (s.friendList || []).length ?? 0) +
      kv('已发到线通知', `${s.noticed ?? 0} 人`) +
      kv('已经是好友', `${s.friends ?? 0} 人`) +
      kv('今天挑过了吗', s.todayPicked ? '挑过了' : '还没') +
      kv('上次主动私聊', s.lastDmAt ? new Date(s.lastDmAt).toLocaleString('zh-CN', { hour12: false }) : '—');

    // 排行榜预览（★ 显示**名字**；号码留着给管理看）
    const board = r.board || [];
    const nm = (x) =>
      `${esc(x.name || '（还没说过话）')} <span class="mono" style="opacity:.55">${esc(x.userId)}</span>`;
    // ⚠️ 2026-10-22：固定渲染 10 行（用户：「没满 10 人直接用占位符填满 10 人的位置」）——
    //    不满的时候空行用浅灰占位，榜单高度稳定，不会"人少就缩成一行"。
    $('aff-board').innerHTML = Array.from({ length: 10 }, (_, i) => {
      const x = board[i];
      return x
        ? `<div class="kv"><b>${i + 1}.</b><span>${nm(x)}</span><span style="margin-left:auto"><b>${x.score}</b></span></div>`
        : `<div class="kv" style="opacity:.3"><b>${i + 1}.</b><span>—</span><span style="margin-left:auto">—</span></div>`;
    }).join('');

    // 好友名单 —— ⚠️ 2026-10-22 挪去「群与触发 → 私聊」了，这里要挡 null
    //    （`f-list` 不在本页了，直接 `$('f-list').innerHTML =` 会 TypeError）。
    const list = s.friendList || [];
    const flEl = $('f-list');
    if (flEl) flEl.innerHTML = list.length
      ? list.map((f) => `<div class="kv"><span>${nm(f)}</span><span style="margin-left:auto">好感度 ${f.score}　${f.lastDmAt ? '上次私聊 ' + new Date(f.lastDmAt).toLocaleDateString('zh-CN') : '还没私聊过'}</span></div>`).join('')
      : '<div class="hint">还没有好友加进来。<br>（⚠️ 协议层发不了加好友申请，所以是"到线时在群里 @ 他、让他来加"。）</div>';
  } catch (e) {
    el.innerHTML = kv('出错', esc(e.message));
  }
}

async function saveAffinity() {
  const el = $('msg-aff');
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      affinity: {
        friendThreshold: Number($('a-threshold').value),
        // ⚠️ 2026-09-30：这两个与上面那条**是两件独立的事**，界面也分开填。
        //    `put('affinity', …)` 是**逐键合并**，所以平铺标量不会冲掉兄弟键。
        sensitiveUnlock: Number($('a-unlock').value),
        sensitiveRetract: Math.min(
          Number($('a-unlock').value) - 1,
          Number($('a-retract').value),
        ),
        boardSize: Number($('a-boardSize').value),
        interactWindowMs: Math.round(Number($('a-window').value) * 60000),
      },
      // ⚠️ 2026-10-22：「到线通知」拆回来了（开关 + 模板）——
      //    主动私聊那几个参数还在「群与触发 → 私聊」（`saveFriendSection()` 管）。
      friend: {
        noticeEnable: $('f-notice-enable')?.checked !== false,
        notice: $('f-notice')?.value ?? '',
      },
    })
  });
  flash(el, r.ok, r.ok ? '已保存并生效' : ('保存失败：' + r.error));
  if (r.ok) renderAffinity();
}

/**
 * 2026-10-22 新增：保存「到线通知 / 主动私聊」那块（`friend` 段）。
 * 它原来挤在 `saveAffinity()` 里，但控件挪到「群与触发 → 私聊」了。
 */
async function saveFriendSection() {
  const el = $('msg-friend');
  try {
    const r = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        friend: {
          dmEnable: $('f-dm-enable').checked,
          dailyChance: Number($('f-chance').value),
          dayFromHour: Number($('f-from').value),
          dayToHour: Number($('f-to').value),
          minGapMs: Math.round(Number($('f-gapHours').value) * 3600000),
        },
      }),
    });
    flash(el, r.ok, r.ok ? '已保存' : '保存失败：' + r.error);
  } catch (e) {
    flash(el, false, '出错：' + e.message);
  }
}

async function testNotice() {
  const el = $('msg-f');
  const uid = $('f-testUid').value.trim();
  if (!uid) return flash(el, false, '先填一个 QQ 号');
  if (!confirm('这会往 1 档群里发一条 @"' + uid + '" 的到线通知。\n（测试不记账，真到 90 的时候还会正常发）\n\n确定吗？')) return;
  const r = await api('/api/friend/test-notice', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ userId: uid })
  });
  flash(el, r.ok, r.ok ? `已发到群 ${r.groupId}` : ('失败：' + r.error));
}

async function previewDm() {
  const el = $('msg-f');
  const uid = $('f-testUid').value.trim();
  if (!uid) return flash(el, false, '先填一个 QQ 号');
  flash(el, null, '正在写…');
  const r = await api('/api/friend/preview-dm', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ userId: uid })
  });
  flash(el, r.ok, r.ok ? '写出来了（见下面）' : ('失败：' + r.error));
  $('f-preview').innerHTML = r.ok ? kv('它会私聊说', esc(r.text)) : '';
}

async function sendDm() {
  const el = $('msg-f');
  const uid = $('f-testUid').value.trim();
  if (!uid) return flash(el, false, '先填一个 QQ 号');
  if (!confirm('这会**真的**给 ' + uid + ' 发一条私聊。\n\n确定吗？')) return;
  flash(el, null, '正在写并发送…');
  const r = await api('/api/friend/send-dm', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ userId: uid })
  });
  flash(el, r.ok, r.ok ? '已私聊发出' : ('失败：' + r.error));
  if (r.ok) $('f-preview').innerHTML = kv('刚才发的', esc(r.text));
}

// ── 生图 ───────────────────────────────────────────────
// ⚠️ 只用来填 placeholder（提示"留空会用哪个"）。
//    留空 = 后端 src/imagegen.js 里那张表说了算 —— **默认值只有一份**，
//    别在这儿再抄一遍当真实值用，抄两遍迟早不一致。
const IG_PRESETS = {
  ark: {
    base: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seedream-4-0-250828',
    // ⚠️ 默认 4K ≈ 1660 万像素（2K 只有 400 万，在 QQ 里显示得跟表情包差不多大）
    size: '4K',
    // ⚠️ 5.0 pro / flash 最高只到 2K，后端会自动夹一下
    sizes: ['1K', '2K', '4K'],
  },
  openai: {
    base: 'https://api.siliconflow.cn/v1',
    model: 'Qwen/Qwen-Image-Edit-2509',
    size: '1024x1024',
    sizes: ['1024x1024', '1024x1536', '1536x1024', '768x1024', '512x512'],
  },
};

/** 填一个 <datalist>（去重；空值丢掉） */
function fillIgList(id, list) {
  const dl = $(id);
  if (!dl) return;
  dl.innerHTML = [...new Set((list || []).filter(Boolean))].map((m) => `<option value="${esc(m)}"></option>`).join('');
}

function igProviderChanged() {
  const p = IG_PRESETS[$('ig-provider').value] || IG_PRESETS.ark;
  $('ig-baseURL').placeholder = p.base + '（留空即用这个）';
  $('ig-model').placeholder = p.model + '（留空即用这个）';
  // ⚠️ 两家的尺寸格式不一样（Ark 认 `2K`，OpenAI 系只认 `1024x1024`）——
  //    只在"当前值还是某个预设的默认值"时才跟着换，别覆盖用户自己填的
  const sizeEl = $('ig-size');
  if (!sizeEl.value || Object.values(IG_PRESETS).some((x) => x.size === sizeEl.value)) sizeEl.value = p.size;
  fillIgList('ig-size-list', p.sizes);
  // 先用默认模型把列表垫上（还没联网也知道有一个能用），下面那次拉取会补全
  fillIgList('ig-model-list', [p.model]);
  igLoadModels({ silent: true });
}

/**
 * 拉生图模型列表 —— **内置候选 ∪ 平台 `/models`**。
 * ⚠️ 内置候选是**兜底**，不是装饰：火山方舟的模型要先去控制台开通才会出现在
 *    `/models` 里，很多生图平台干脆没实现这个接口。拉不到也得能选。
 */
async function igLoadModels(opts = {}) {
  const hint = $('ig-model-hint');
  const btn = $('btn-ig-models');
  if (btn) btn.disabled = true;
  if (!opts.silent && hint) {
    hint.textContent = '正在从 API 拉取模型列表…';
    hint.style.color = '';
  }
  try {
    const r = await api('/api/imagegen/models', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ imagegen: {
        provider: $('ig-provider').value,
        baseURL: $('ig-baseURL').value.trim(),
        apiKey: $('ig-apiKey').value.trim(),
      }})
    });
    if (!r || !r.ok) {
      if (hint) {
        hint.textContent = `拉取失败（${(r && r.error) || '接口没响应'}）—— 可以直接在输入框里手打模型名。`;
        hint.style.color = '#d97706';
      }
      return;
    }
    fillIgList('ig-model-list', r.models);
    if (!hint) return;
    // ⚠️ 平台那边失败**不算整体失败**（内置候选照旧能用），所以话要说清楚，别一律报红
    if (r.error) {
      hint.textContent = `平台那边没拉到（${r.error}）—— 先用内置的 ${r.builtin} 个候选，也能直接手打。`;
      hint.style.color = '#d97706';
    } else if (r.live) {
      hint.textContent = `平台有 ${r.live} 个模型（生图的排在最前面），另有内置候选 ${r.builtin} 个 —— 点输入框就能选。`;
      hint.style.color = '#16a34a';
    } else {
      hint.textContent = `内置 ${r.builtin} 个候选（还没填 API Key，所以没去平台拉）—— 点输入框就能选，也能手打。`;
      hint.style.color = '';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 显示本地缓存占用（**只统计不删**） */
async function igCacheInfo() {
  const el = $('ig-cache-info');
  if (!el) return;
  try {
    const r = await api('/api/imagegen/cache', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ dryRun: true }),
    });
    if (!r || !r.ok) return;
    el.textContent = `本地 ${r.count} 张 / ${(r.bytes / 1048576).toFixed(1)} MB`;
  } catch { /* 统计失败不该弹错，忽略 */ }
}

/** 立即清掉过期的（保留时长按上面那个输入框） */
async function igSweep() {
  const btn = $('btn-ig-sweep');
  [[btn, 'disabled']].forEach(([b, k]) => b && (b[k] = true));
  try {
    const r = await api('/api/imagegen/cache', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({}),
    });
    if (!r || !r.ok) return flash($('msg-ig'), false, '清理失败');
    if (!r.enabled) flash($('msg-ig'), null, '保留时长是 0（不自动删）—— 什么都没清');
    else if (r.removed) flash($('msg-ig'), true, `清掉 ${r.removed} 张（${(r.freedBytes / 1048576).toFixed(1)} MB）`);
    else flash($('msg-ig'), null, `没有过期的（本地还留 ${r.count} 张）`);
    igCacheInfo();
  } finally {
    if (btn) btn.disabled = false;
  }
}

/** 保存生图配置 */
async function saveImagegen() {
  const el = $('msg-ig');
  // ⚠️⚠️ 画风必须**两个一起发**：后端存的时候是整段 `style` 对象替换，
  //    只发一半会把另一半从 config.yml 里抹掉。
  // ⚠️ 输入框留空 = **不动那一项**（退回上次读到的值），不是清空 ——
  //    清空会让提示词退回兜底那一句，画风就废了。
  const cur = (STATE && STATE.config && STATE.config.imagegen && STATE.config.imagegen.style) || {};
  const sSelf = $('ig-style-self').value.trim();
  const sScene = $('ig-style-scene').value.trim();
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ imagegen: {
      enable: $('ig-enable').checked,
      provider: $('ig-provider').value,
      baseURL: $('ig-baseURL').value.trim(),
      model: $('ig-model').value.trim(),
      size: $('ig-size').value.trim(),
      apiKey: $('ig-apiKey').value.trim(),
      timeoutMs: Number($('ig-timeoutMs').value),
      cooldownMs: Number($('ig-cooldownMs').value),
      keepHours: Math.max(0, Number($('ig-keepHours').value) || 0),
      style: { self: sSelf || cur.self || '', scene: sScene || cur.scene || '' },
    }})
  });
  flash(el, r.ok, r.ok ? '已保存并生效' : ('保存失败：' + r.error));
  if (r.ok) reloadAll();
}

/**
 * 测试出图 —— ⚠️ **会真的出一张图**（火山方舟 0.20 元/张），按钮上写明了。
 * 用人设包里那张参考图 + 一个日常自拍场景，出图后**直接在下面预览** ——
 * 点一下就能判断"像不像她"，这也是唯一有意义的测试。
 */
async function testImagegen() {
  const el = $('msg-ig');
  const box = $('ig-preview');
  box.innerHTML = '';
  flash(el, null, '正在理解 + 出图…（10~40 秒）');
  const r = await api('/api/imagegen/test', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      // ⚠️ 这个输入框是「假装群友说的那句话」；kind 是她自己写的标记（auto=不写）
      prompt: $('ig-testScene').value.trim(),
      kind: $('ig-testKind').value,
      imagegen: {
        enable: true,
        provider: $('ig-provider').value,
        baseURL: $('ig-baseURL').value.trim(),
        model: $('ig-model').value.trim(),
        size: $('ig-size').value.trim(),
        apiKey: $('ig-apiKey').value.trim(),
        timeoutMs: Number($('ig-timeoutMs').value),
      },
    })
  });
  if (!r.ok) {
    // ⚠️ 两行分开显示（2026-09-22 实测踩到「模型没开通」之后改的）：
    //    上面那行是**她会说的话**，下面那行是**给你**的下一步 ——
    //    只给"相机坏了"，用户根本不知道要去控制台开通模型。
    box.innerHTML = r.hint
      ? '<div class="hint" style="margin:0;color:#b45309">' +
        '<b>出图失败。</b>群里她会说：「' + esc(r.error) + '」<br>' + esc(r.hint) + '</div>'
      : '';
    return flash(el, false, '出图失败');
  }
  flash(el, true, `成功，${Math.round((r.ms || 0) / 1000)} 秒`);
  const used = r.withSelf === false
    ? '这条路没有参考图（拍的是景物，她本来就不在画面里）'
    : r.refNames && r.refNames.length
      ? '参考图：' + esc(r.refNames.join('、'))
      : '⚠️ 没有参考图 —— 生成的脸每次都不一样。去「人设」页传一张立绘。';
  // ⚠️ 把「理解成了什么」也显示出来 —— 调画风/调场景时只有看得见才调得动
  const p = r.picked || {};
  const detail =
    '<div class="hint" style="margin-top:6px;line-height:1.7">' +
    used +
    '<br>她此刻：' + esc((r.facts && r.facts.now) || '?') + ' · ' + esc((r.facts && r.facts.where) || '?') +
    '<br>理解成：' + (r.withSelf ? '<b>画面里有她</b>' : '<b>她拍的东西（没有她）</b>') +
    '，拍「' + esc(p.what || '') + '」' +
    (p.place ? '，地点「' + esc(p.place) + '」' : '') +
    (p.time ? '，时间「' + esc(p.time) + '」' : '') +
    '<br><span style="color:#6b7280">最终提示词（' + String(r.prompt || '').length + ' 字）：' +
    esc(r.prompt || '') + '</span></div>';
  box.innerHTML =
    '<img src="' + r.dataUrl + '" style="max-width:340px;border-radius:10px;border:1px solid #e5e7eb">' + detail;
}

// ── 保存：活跃度 ──
async function saveTrigger() {
  // ⚠️ 这份设置横跨两个卡片（「它能在哪些群说话」+「回复与分条」），
  //    两边各有一个保存按钮，点了都要有反馈 —— 所以两个提示位都刷。
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      trigger: {
        // ⚠️ 2026-10-22：`allowGroups`（哪些群能说话）**不在这个保存里了** ——
      //    它改成了分群列表里的「允许发言」勾，由 `setGroupAllow()` 单独即时保存。
      //    ⚠️ 别把这个字段加回来：那个 textarea 已经删了，`$('trigger-allowGroups')` 是 null。
        allowPrivateUsers: lines($('trigger-allowPrivateUsers').value),
        // ⚠️ 2026-10-22：`groupChat`（群聊应答总开关）也**不在这个保存里了** ——
        //    它挪到「群里回复灵敏度」那张卡，由 `saveRespondTo()` 一起提交。
        privateChat: $('trigger-privateChat').checked,
        historyRounds: Number($('trigger-historyRounds').value),
        cooldownMs: Number($('trigger-cooldownMs').value),
      },
      chunking: {
        maxChars: Number($('chunking-maxChars').value),
        delayMs: Number($('chunking-delayMs').value),
        delayMaxMs: $('chunking-delayMaxMs').value === '' ? undefined : Number($('chunking-delayMaxMs').value),
      },
      teach: {
        teachers: lines($('teach-teachers').value),
        allowPrivateTeach: $('teach-allowPrivateTeach').checked,
        keywords: $('teach-keywords').value.split(/[,，]/).map(s => s.trim()).filter(Boolean),
      },
    })
  });
  for (const id of ['msg-groups', 'msg-trigger']) {
    const el = $(id);
    if (el) flash(el, r.ok, r.ok ? '已保存并生效' : ('保存失败：' + r.error));
  }
  if (r.ok) reloadAll();
}

// ── 单人频率闸（2026-10-02）──
// ⚠️ 单独一个函数，别并进 saveTrigger：那两个按钮管的是「节奏」，
//    这三个数管的是「省调用」，混在一起时保存失败会互相牵连、看不出是谁的问题。
async function savePerUser() {
  // ⚠️ 硬阈值低于软阈值就在前端拦一手（config.js 那边也会兜底改写，
  //    但那时用户已经存进去了、界面上显示的和自己存的不一样，很难查）。
  const soft = Math.max(0, Math.round(Number($('chatPerUser-softLimit').value) || 0));
  let hard = Math.round(Number($('chatPerUser-hardLimit').value) || 0);
  if (hard && hard <= soft) {
    const el0 = $('msg-perUser');
    if (el0) flash(el0, false, `硬阈值必须比软阈值大（现在 ${hard} ≤ ${soft}），已自动改成 ${soft + 1}`);
    hard = soft + 1;
    $('chatPerUser-hardLimit').value = hard;
  }
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      chat: {
        perUser: {
          enable: $('chatPerUser-enable').checked,
          windowMs: Math.max(10000, Number($('chatPerUser-windowMs').value) || 300000),
          softLimit: soft,
          hardLimit: hard,
        },
      },
    })
  });
  const el = $('msg-perUser');
  if (el) flash(el, r.ok, r.ok ? '已保存并生效' : ('保存失败：' + r.error));
  if (r.ok) reloadAll();
}

// ⚠️ 召唤频率闸 —— **独立函数 + 独立按钮**（用户 2026-10-03 要求能单独关）。
//    别并进 savePerUser：两个闸的量级差着好几倍（6 vs 10 次）、
//    窗口也不同（5 分钟 vs 2 分钟），混在一张卡里调不动、也看不出是谁的问题。
async function savePerUserCall() {
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      chat: {
        perUserCall: {
          enable: $('chatPerUserCall-enable').checked,
          // ⚠️ 下限 10 秒：更短的窗口统计不出刷屏，只是随机抖动（和 config.js 一致）。
          windowMs: Math.max(10000, Number($('chatPerUserCall-windowMs').value) || 120000),
          // ⚠️ 下限 1：存 0 会变成"永远放行"（0 次就等于关），那是配置写错。
          limit: Math.max(1, Math.round(Number($('chatPerUserCall-limit').value) || 10)),
        },
      },
    })
  });
  const el = $('msg-perUserCall');
  if (el) flash(el, r.ok, r.ok ? '已保存并生效' : ('保存失败：' + r.error));
  if (r.ok) reloadAll();
}

// ── QQ 空间 ──

// ── QQ 登录 ──

async function qqRefresh() {
  const el = $('qq-status');
  if (!el) return;
  el.innerHTML = kv('状态', '正在查…');
  try {
    const r = await api('/api/qq/status');
    if (!r.ok) { el.innerHTML = kv('出错', esc(r.error || '查询失败')); return; }
    const n = r.napcat || {};
    const o = r.onebot || {};
    // ⚠️ 协议端（2026-09-17 加）：收发跟它无关，但"出码/重启"这些能力由它决定。
    //    不支持的能力**把按钮禁掉并说明去哪儿做** —— 比点了弹错好。
    const pv = r.provider || {};
    const caps = pv.caps || {};

    // 两边都看：NapCat 说「已登录」不代表 QQ 真在线
    const online = o.online === true;
    const badge = online
      ? '<b style="color:#16a34a">✅ 在线</b>'
      : '<b style="color:#dc2626">❌ 离线（收不到消息）</b>';

    let html =
      kv('协议端', esc(pv.label || '—') +
        (pv.manageUrl ? ' · <a href="' + esc(pv.manageUrl) + '" target="_blank">它自己的管理界面</a>' : '') +
        // ⚠️⚠️ 2026-09-19 加（用户要求：「在 webui 加个切换控制」）：
        //    界面上直接换协议端 = 改 `config.yml` 的 `provider.name`。
        //    ⚠️ **收发本身跟协议端无关**（都走 onebot.url + token），换的是
        //      "出码 / 重启 / 启停 / 假在线自愈"这些**管理能力**；
        //    ⚠️ 而 provider 是**启动时读**的 → **改完必须重启机器人才生效**，
        //      所以这里把这句话写在旁边，别让人以为一选就换过去了。
        //    ⚠️ 选项写死这几个是故意的（= `provider.js` 里 REGISTRY 的键）。
        //    ⚠️⚠️ 2026-09-20：**这三处必须同时有这个协议端，否则会被"归一化成 onebot"**：
        //       ① `provider.js` 的 REGISTRY  ② `config.js` 的 KNOWN_PROVIDERS
        //       ③ 就是这行选项。
        //       今天就踩了：换到 SnowLuma 之后只改了 ①，结果启动日志打
        //       「已连接到协议端（onebot）」、界面显示「通用 OneBot 11 实现」——
        //       因为 config.js 的白名单里没有它，`name` 被改成了 onebot
        //       （原值只留在 `provider.nameRaw` 里，害我查了半天）。
        //      将来加协议端，这里要跟着加（或者让 `/api/status` 把 NAMES 带过来）。
        ' <select id="pv-name" style="margin-left:6px;vertical-align:middle">' +
        ['napcat', 'llonebot', 'snowluma', 'onebot']
          .map((x) => '<option value="' + x + '"' + (x === pv.name ? ' selected' : '') + '>' + x + '</option>')
          .join('') +
        '</select>' +
        ' <button onclick="qqSwitchProvider()">切换</button>' +
        ' <span class="hint">换完**重启机器人**才生效；收发不受影响，出码/重启那些按钮会跟着变</span>') +
      kv('QQ 是否在线', badge) +
      kv('账号', esc(o.qq || '—') + (o.nickname ? ' (' + esc(o.nickname) + ')' : '') +
        ' <span class="hint">（这条来自 OneBot 侧，换任何协议端都准）</span>');

    // 只对支持的协议端显示"进程在不在"（别的协议端我们探测不到）
    const running = r.running === true;
    if (caps.status || caps.launch) {
      html += kv(
        '协议端进程',
        running ? '<b style="color:#16a34a">在跑</b>' : '<b style="color:#dc2626">没在跑</b>',
      );
    }

    // ⚠️⚠️ 2026-09-20 加（用户：「webui 加一个重启机器人的」+「要能成功切换端口」）：
    //    **重启机器人**和"重启协议端"是两件事 —— 前者只是按当前 config 重连一次
    //    协议端（SnowLuma / LLBot 都支持，不涉及 QQ 登录），而后者 SnowLuma 压根没有。
    //    改完配置（尤其切协议端）**必须重启机器人才生效**，所以这个按钮放在状态页最显眼处。
    html += kv(
      '机器人进程',
      '<button class="ghost" id="btn-bot-restart" onclick="qqRestartBot()">重启机器人</button>' +
        ' <span class="hint">= 按当前配置重新连一次协议端（改完配置 / 切完协议端点它生效）；' +
        '**不是**重启协议端，也不涉及 QQ 登录</span>',
    );

    // 按钮跟着"状态 + 协议端能力"变
    const btn = $('btn-qq-restart');
    if (btn) {
      const canRestart = caps.restart === true || caps.launch === true;
      btn.disabled = !canRestart;
      btn.textContent = !canRestart
        ? '当前协议端不支持（看它自己的界面）'
        : running && caps.restart
          ? '重启协议端（重新出码）'
          : '启动协议端';
      btn.style.background = !canRestart ? '#6b7280' : running && caps.restart ? '#dc2626' : '#16a34a';
    }
    const h = $('qq-restart-hint');
    if (h) {
      if (pv.how) h.textContent = pv.how + (pv.license ? '　｜　' + pv.license : '');
    }

    // ⚠️⚠️ 2026-09-20 修（用户截图：LLBot 下这里显示「NapCat 管理接口 连不上 — fetch failed」）：
    //    我为 LLBot 也打开了 `caps.status`（为了能看登录状态），可**这一段的字段全是
    //    NapCat 专属的**（`r.napcat` = 它 6099 那套 HTTP 接口）→ LLBot 也走进来、显示"连不上" ✗
    //    ⇒ 按协议端分开：**只有 napcat 才显示这几张卡**。
    //      LLBot 的登录状态在**二维码那张卡**上看（它会直接把正在出的码显示出来，
    //      "在出码"就等于"没登录"，见 `src/llbot.js`）。
    const isNapcat = String(pv.name || '').toLowerCase() === 'napcat';
    if (isNapcat && !caps.status) {
      html += kv('协议端管理接口', '<span class="hint">' + esc(n.error || '当前协议端没有这套接口') + '</span>');
    } else if (isNapcat && !n.reachable) {
      html += kv('NapCat 管理接口', '<b style="color:#dc2626">连不上</b> — ' + esc(n.error || ''));
    } else if (isNapcat) {
      html += kv('NapCat 侧登录状态', n.isLogin ? '已登录' : '未登录');
      if (n.isOffline) html += kv('NapCat 侧', '<b style="color:#dc2626">标记为离线</b>');
      if (n.loginError) html += kv('登录错误', esc(n.loginError));
      if (n.quickLogin && n.quickLogin.length) {
        html += kv('可快速登录的号', n.quickLogin.map(esc).join('、'));
      }
    }
    el.innerHTML = html;
  } catch (e) {
    el.innerHTML = kv('出错', esc(e.message));
  }
}

/**
 * 显示二维码。
 *
 * ⚠️⚠️ `?fresh=1` 不能省（2026-09-15 修）。原因：
 *   `GetQQLoginQrcode`（原来唯一走的那个接口）**只是把缓存里的 URL 读出来，
 *   根本不会重出二维码** —— 而码几分钟就死。所以以前这里画出来的
 *   十有八九是**一张早就过期的码**，用户「从来没扫成功过」。
 *   带上 `fresh=1` 后，后端会先调 `RefreshQRcode` 让 QQ **现生成一张**再返回。
 */
async function qqReloadQr() {
  const card = $('qq-qr-card');
  const img = $('qq-qr-img');
  if (!card || !img) return;
  card.style.display = '';
  // ⚠️ 协议端没在跑的时候出不了码（后端直接 503），别让浏览器去请求一个空白图
  const st = await api('/api/qq/status').catch(() => null);
  if (st && st.running === false) {
    img.removeAttribute('src');
    if ($('qq-qr-hint')) {
      $('qq-qr-hint').textContent =
        (st.provider?.label || '协议端') + ' 没在运行，出不了码 —— 先把它启动起来。';
    }
    return;
  }
  // ⚠️⚠️ 2026-09-20 加：**拿不到图的时候不许留一张破图**（用户截图里就是那个样子：
  //    一个破图图标 + alt 文字）。后端在 409/404/503 时回的是 **JSON（原因）**，
  //    浏览器把它当图片加载就会显示破图。⇒ 在 onerror 里再问一次拿原因，
  //    然后**把破图撤掉、只留文字**。
  img.onerror = async () => {
    img.removeAttribute('src');
    let reason = '';
    try {
      const r = await fetch('/api/qq/qrcode.png?fresh=1&t=' + Date.now());
      reason = (await r.json()).error || '';
    } catch {}
    if ($('qq-qr-hint')) $('qq-qr-hint').textContent = reason || '这次拿不到二维码。';
  };
  img.src = '/api/qq/qrcode.png?fresh=1&t=' + Date.now();
  if ($('qq-qr-hint')) $('qq-qr-hint').textContent = '正在取码…扫不出来就点「重新出码」。';
}

/**
 * 轻量「重新出码」：让 NapCat 现生成一张（`RefreshQRcode`），**不重启进程**。
 *
 * ⚠️ 以前这个按钮走的是「重启 NapCat」——那是**一次 QQ 登录**（风控信号）、
 *    要等 20 秒，而且新实例还没生成码界面就去取 → 「重新出码也一直不出」。
 */
async function qqNewQr() {
  const btn = $('btn-qq-newqr');
  const img = $('qq-qr-img');
  if (btn) { btn.disabled = true; btn.textContent = '正在出码…'; }
  try {
    const r = await api('/api/qq/refresh-qr', { method: 'POST' });
    const card = $('qq-qr-card');
    if (card) card.style.display = '';
    if (img) img.src = '/api/qq/qrcode.png?t=' + Date.now();
    // ⚠️⚠️ 2026-09-20 修（用户截图：界面写着「已生成新码，扫吧。」，下面是张**破图**）：
    //    旧代码**只看 `r.ok`** 就宣布成功。而 LLBot 想出码也出不来的时候
    //    （它连出 10 张没人扫就**停止出码**了），后端会回
    //    `{ok:true, hasImage:false, message:'…'}` → 界面于是在**撒谎**。
    //    ⇒ **以 `hasImage` 为准**；没拿到图就如实转述后端给的原因。
    if ($('qq-qr-hint')) {
      $('qq-qr-hint').textContent = r.ok && r.hasImage
        ? '已生成新码，扫吧。'
        : r.message || '这次没拿到新码 —— LLBot 那边可能停止出码了，去它的界面点「刷新」。';
    }
  } catch (e) {
    if ($('qq-qr-hint')) $('qq-qr-hint').textContent = '出码出错：' + e.message;
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = '重新出码'; }
  }
}

/**
 * 切换协议端（改 `config.yml` 的 `provider.name`）→ 保存后**问一句要不要立刻重启机器人**。
 *
 * ⚠️⚠️ 2026-09-20 加（用户原话：「**要能成功切换端口**」）：
 *    原来切完只弹一句「已保存。重启机器人后生效」—— 而"重启机器人"的入口在别的卡片里，
 *    用户切完很容易**以为已经切好了**，实际收发还在走老协议端 ✗
 *    ⇒ 切完直接问「现在重启吗」，点一下就走 `/api/bot/restart`，这才叫"切换成功"。
 *    ⚠️ 用 `confirm` 而不是自动重启：万一用户只是在看选项、并不想现在断线。
 */
async function qqSwitchProvider() {
  const sel = $('pv-name');
  const name = sel ? sel.value : '';
  if (!name) return;
  let j;
  try {
    j = await api('/api/config', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ provider: { name } }),
    });
  } catch (e) {
    alert('保存失败：' + e.message);
    return;
  }
  if (!j || !j.ok) {
    alert('保存失败：' + ((j && j.error) || '未知'));
    return;
  }
  if (
    confirm(
      '已切到「' +
        name +
        '」。\n\n要现在重启机器人让它生效吗？\n（约 15~30 秒，期间收不到消息；不重启的话它仍按老协议端跑）',
    )
  ) {
    qqRestartBot();
  } else {
    alert('已保存。记得自己重启机器人才生效 —— 状态页有「重启机器人」按钮。');
  }
}

/**
 * 重启机器人 —— 按当前配置重新连一次协议端。
 * ⚠️ **不是**重启协议端，也**不涉及 QQ 登录**（协议端是独立进程，这条 2026-09-20 实测过）。
 */
async function qqRestartBot() {
  const btn = $('btn-bot-restart');
  if (btn) {
    btn.disabled = true;
    btn.textContent = '正在重启…';
  }
  try {
    const r = await api('/api/bot/restart', { method: 'POST' });
    alert((r && r.message) || '正在重启机器人…十几秒后自己回来，刷新页面即可。');
  } catch (e) {
    alert('重启请求失败：' + e.message);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = '重启机器人';
    }
  }
}

async function qqRecover() {
  const btn = $('btn-qq-recover');
  const msg = $('qq-recover-msg');
  btn.disabled = true;
  btn.textContent = '正在尝试…（最多 15 秒）';
  if (msg) msg.textContent = '先试快速登录（不用扫码），不行再出二维码…';
  try {
    const r = await api('/api/qq/recover', { method: 'POST' });
    if (msg) {
      msg.innerHTML = r.recovered
        ? '<b style="color:#16a34a">✅ ' + esc(r.message) + '</b>'
        : '<b style="color:#d97706">⚠️ ' + esc(r.message) + '</b> —— 请扫下面的二维码';
    }
    await qqRefresh();
    if (!r.recovered) qqReloadQr();
  } catch (e) {
    if (msg) msg.textContent = '出错：' + e.message;
  } finally {
    btn.disabled = false;
    btn.textContent = '一键恢复登录（先试免扫码）';
  }
}

async function qqRestart() {
  const btn = $('btn-qq-restart');
  // 先问一下服务端「NapCat 到底在不在跑」——不在跑就是「启动」，不是「重启」
  const st = await api('/api/qq/status').catch(() => null);
  const running = !!(st && st.running === true);
  const ask = running
    ? '重启 NapCat 会短暂断开机器人连接（几秒后自己重连）。\n如果只是网络抖断、QQ 已经自己重连上了，就不需要点这个。\n\n确定要重启吗？'
    : 'NapCat 现在没在运行，点确定会把它启动起来：\n' +
      '· 会先关掉没被注入 NapCat 的残留 QQ 进程；\n' +
      '· 然后开一个 NapCat 窗口（最小化在任务栏）；\n' +
      '· 登录态还在就自己登回去，失效了要在那个窗口里扫码。\n\n确定要启动吗？';
  if (!confirm(ask)) return;
  btn.disabled = true;
  btn.textContent = running ? '正在重启…（约 20 秒）' : '正在启动…（最多等 1 分钟）';
  try {
    const r = await api('/api/qq/restart', { method: 'POST' });
    if (!r.ok) {
      alert((r.launched ? '启动遇到问题：' : '重启失败：') + r.message);
      await qqRefresh();
      return;
    }
    // 启动要等 NapCat 起来（服务端已经等过了），重启则按老规矩等 15 秒
    await new Promise((res) => setTimeout(res, running ? 15000 : 2000));
    await qqRefresh();
    if (r.launched) await qqNewQr(); // 起来了就把码拿出来，省得再去任务栏翻窗口
    else qqReloadQr();
    await qqRefresh();
  } finally {
    btn.disabled = false;
    btn.textContent = '重启 NapCat（重新出码）';
  }
}

// ── 分群灵敏度 ──

const RESP_LABEL = {
  0: '跟随全局',
  1: '① 什么都可能接（最活跃）',
  2: '② 只接服务器话题/聊到它',
  3: '③ 只认 @（最安静）',
};

async function loadGroupRespond() {
  const el = $('group-respond-list');
  if (!el) return;
  el.textContent = '加载中…';
  try {
    const r = await api('/api/qq/groups');
    if (!r.ok) { el.textContent = '出错：' + (r.error || '取群列表失败'); return; }
    const per = r.perGroup || {};
    if (!r.groups.length) {
      el.textContent = '没取到群列表（机器人可能没连上 QQ）';
      return;
    }
    const ans = r.answerServer || {};
    // ⚠️ 2026-10-22 加：「允许发言」勾（`trigger.allowGroups`）。
    //    ⚠️ 语义小心：**空名单 = 全部允许**（配置默认），非空 = 只有名单里的群。
    //    ⇒ 空名单时列表里所有群都显示为勾上。
    const allowList = (r.allowGroups || []).map(String);
    const allowAll = allowList.length === 0;
    const isAllowed = (id) => allowAll || allowList.includes(String(id));
    el.innerHTML = r.groups.map((g) => {
      const cur = per[g.id] ?? 0;
      const opts = [0, 1, 2, 3].map((v) =>
        `<option value="${v}"${v === cur ? ' selected' : ''}>${esc(RESP_LABEL[v])}</option>`,
      ).join('');
      const mark = per[g.id] ? ' <b style="color:#d97706">已单独设置</b>' : '';
      return `<div class="gr-row" data-gid="${esc(g.id)}">
        <div class="gr-name">${esc(g.name || '(无名群)')}<span class="gr-id">${esc(g.id)}${g.count ? ' · ' + g.count + ' 人' : ''}</span>${mark}</div>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;white-space:nowrap;margin:0" title="取消勾选 = 这个群她完全不说话（也不处理消息）。这是**按群**的开关，和上面的「群聊应答」总开关是两回事 —— 总开关关掉时所有群都不说。">
          <input type="checkbox"${isAllowed(g.id) ? ' checked' : ''}
            onchange="setGroupAllow('${esc(g.id)}', this.checked, this)"> 允许发言
        </label>
        <label style="display:flex;align-items:center;gap:6px;font-size:13px;opacity:.92;white-space:nowrap;margin:0" title="⚠️ 默认关。群里已经有好几个 bot 的时候，服务器问题会被重复回答（一屏都是同一种话）⇒ 关掉 = 没 @ 她、也没引用她时**不主动答**服务器问题；带 @ 或引用她的照答。">
          <input type="checkbox"${ans[g.id] ? ' checked' : ''}
            onchange="setGroupAnswerServer('${esc(g.id)}', this.checked, this)"> 主动回服务器消息
        </label>
        <select onchange="setGroupRespond('${esc(g.id)}', this.value, this)">${opts}</select>
      </div>`;
    }).join('');
  } catch (e) {
    el.textContent = '出错：' + e.message;
  }
}

// ══════════════════════════════════════════════════════════════
// 骰娘模式（2026-09-30）—— 触发词按用户要求做成可在界面上改
//
// ⚠️ 为什么用现成的 tagRow/tagsSync/pjList：
//   触发词本来就是**数组**，而那套组件（人设的「她怎么称呼别人」在用）
//   就是为数组做的。复用它 = 交互一致，也不用另写一遍增删逻辑。
// ⚠️ 为什么**不**把 `sealdice.token` 也放进界面：那是本机密钥，
//   界面只用来改触发词就够了。
// ══════════════════════════════════════════════════════════════

/** 拉一次配置并回填骰娘模式那张卡 */
async function renderDiceMode() {
  const msg = $('msg-dm');
  try {
    const r = await api('/api/config');
    if (!r.ok) { flash(msg, false, '读配置失败：' + (r.error || '')); return; }
    const d = r.config?.diceMode ?? {};
    $('dm-enable').checked = d.enable !== false;
    // ⚠️ 分钟 ⇄ 毫秒：config.yml 里存的是毫秒，界面上填分钟更好读
    $('dm-duration').value = Math.round((Number(d.durationMs) || 0) / 60000);

    const box = $('dm-tagger');
    if (!box) return;
    const tagRow2 = (label, id, value, hint) => {
      const { ph: p2, tip } = hintSplit(hint);
      return (
        '<div class="fld">' +
        '<label>' + label + (tip ? '<span class="q" tabindex="0" data-q="' + escAttr(tip) + '">?</span>' : '') + '</label>' +
        '<div class="tags" id="tags-' + escAttr(id) + '" data-for="' + escAttr(id) + '">' +
        '<input class="tagadd" placeholder="' + escAttr(p2 || '输入后回车') + '">' +
        '</div>' +
        '<input type="hidden" id="' + escAttr(id) + '" value="' + escAttr(value) + '">' +
        '</div>'
      );
    };
    box.innerHTML =
      tagRow2('进去的触发词（整句相等）', 'dm-enter', (d.enterKeys ?? []).join('、'),
        '她进入骰娘模式的话。⚠️ 必须**整句相等**：写「骰娘」就只有发「骰娘」两个字才触发，'
        + '而「骰娘好可爱」不会。之所以不用关键词匹配，是因为误进骰娘模式会让整局停摆。') +
      tagRow2('退出的触发词', 'dm-exit', (d.exitKeys ?? []).join('、'),
        '解除用的。权限跟进去一样（服主 / 群管理员 / 白名单）。') +
      tagRow2('不当作骰点的句子', 'dm-skip', (d.skipDiceKeys ?? []).join('、'),
        '例外清单。默认凡带「.」或「/」开头且后跟命令词的都算骰点（海豹命令很多，穷举会漏），'
        + '所以用这个黑名单排除个别句子。');
    tagsSync('dm-enter');
    tagsSync('dm-exit');
    tagsSync('dm-skip');
  } catch (e) {
    flash(msg, false, '出错：' + e.message);
  }
}

/** 把那张卡上的值存进 config.yml */
async function saveDiceMode() {
  const msg = $('msg-dm');
  try {
    const r = await api('/api/config', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        diceMode: {
          enable: $('dm-enable').checked,
          // ⚠️ `pjList` 按「、，,换行」拆，正好对应 tagRow 的输入格式
          enterKeys: pjList($('dm-enter').value),
          exitKeys: pjList($('dm-exit').value),
          skipDiceKeys: pjList($('dm-skip').value),
          // ⚠️ 界面填「分钟」，config.yml 存「毫秒」—— 别搞反了
          durationMs: Math.max(0, Number($('dm-duration').value) || 0) * 60000,
        },
      }),
    });
    flash(msg, r.ok, r.ok ? '已保存并生效' : ('保存失败：' + r.error));
    if (r.ok) await renderDiceMode();
  } catch (e) {
    flash(msg, false, '出错：' + e.message);
  }
}
// ══════════════════════════════════════════════════════════════
// 海豹转述开关已退役（2026-10-22）：骰点唯一入口是骰桥 `src/seal-bridge.js`，
// 桥按 `GET /api/dice-mode` 决定「在骰娘模式 → 转 /api/seal-say」或「直接拦住不发」。
// ══════════════════════════════════════════════════════════════
/**
 * 「这个群回不回服务器消息」（2026-10-07 从「按群设定」页搬过来的）。
 *
 * ⚠️ 为什么搬：用户原话是「在**分群调节**那里加一个是否回服务器消息的选项」——
 *    而它原来在「按群设定」页，那一页**只列 1 档群**（事件系统的门槛），
 *    于是 2/3 档群压根看不到这个开关 ⇒ 用户报「找不到了」。
 *    它本来就跟事件系统无关（是"她怎么说话"），放在分群档位旁边才对。
 */
/**
 * 2026-10-22 加：按群的「允许发言」开关（写 `trigger.allowGroups`）。
 *
 * ⚠️⚠️ 语义坑：**空名单 = 全部允许**（配置默认），非空 = 只有名单里的群。
 *    ⇒ 从"全部允许"里禁言某一个群时，必须把**其余所有群都显式写进名单**，
 *      否则存成空数组就变成"全部允许"，禁言反而失效。
 * ⚠️ 另一个边界：如果禁言完名单变空（只有一个群），那又会回到"全部允许" ——
 *    这种情况直接拒绝并提示用「群聊应答」总开关，别存出一个自相矛盾的配置。
 */
async function setGroupAllow(gid, on, box) {
  const msg = $('msg-group-respond');
  if (box) box.disabled = true;
  try {
    const r0 = await api('/api/qq/groups'); // 拿全量群列表：空名单展开时要用
    const cur = (r0.allowGroups || []).map(String);
    let next;
    if (on) {
      next = [...new Set([...cur, String(gid)])];
    } else if (cur.length === 0) {
      next = (r0.groups || []).map((g) => String(g.id)).filter((x) => x !== String(gid));
    } else {
      next = cur.filter((x) => x !== String(gid));
    }
    if (!next.length) {
      flash(msg, false, '这是最后一个能说话的群 —— 要全部禁言请用上面的「群聊应答」总开关');
      if (box) box.checked = true;
      return;
    }
    const r = await api('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ trigger: { allowGroups: next } }),
    });
    flash(msg, r.ok, r.ok ? `${gid}：${on ? '允许发言' : '已禁言'}` : '保存失败：' + r.error);
    if (r.ok) await loadGroupRespond();
  } catch (e) {
    flash(msg, false, '出错：' + e.message);
  } finally {
    if (box) box.disabled = false;
  }
}

/**
 * 2026-10-22 新增：分群灵敏度的「保存」按钮。
 *
 * ⚠️ 每一行的勾选/下拉本来就是**即时保存**的（onchange 直接打接口）。
 *    用户还是想要一个显式的保存按钮（「分群灵敏度那一页是不是也可以加个保存按钮」），
 *    ⇒ 这里把当前所有行的值**按顺序重新提交一遍**（幂等，不会改变结果），
 *    给一个明确的"存好了"反馈。别改成"先攒着最后存" —— 那样中途刷新就丢改动。
 */
async function saveAllGroupRespond() {
  const el = $('msg-group-respond');
  if (el) { el.style.color = ''; el.textContent = '保存中…'; }
  try {
    const rows = [...document.querySelectorAll('#group-respond-list .gr-row')];
    let ok = 0;
    let bad = [];
    for (const row of rows) {
      const gid = String(row.dataset.gid || '');
      if (!gid) continue;
      const chk = row.querySelector('input[type=checkbox]');
      const sel = row.querySelector('select');
      if (!chk || !sel) continue;
      // ⚠️ 接口要和 `setGroupRespond()` 用同一个（`/api/qq/group-respond`），
      //    不是 `/api/group-params` —— 后者是「按群参数」那页的。
      const r = await api('/api/qq/group-respond', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: gid, level: Number(sel.value) }),
      });
      if (r.ok) ok++;
      else bad.push(gid);
    }
    flash(el, !bad.length, bad.length ? `有 ${bad.length} 个群没存上：${bad.join('、')}` : `已保存 ${ok} 个群`);
  } catch (e) {
    flash(el, false, '出错：' + e.message);
  }
}

async function setGroupAnswerServer(gid, on, box) {
  const msg = $('msg-group-respond');
  if (box) box.disabled = true;
  try {
    const r = await api('/api/group-params', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: gid, patch: { chat: { answerServer: !!on } } }),
    });
    flash(msg, r.ok, r.ok ? `${gid}：回服务器消息已${on ? '打开' : '关闭'}` : '保存失败：' + r.error);
    if (r.ok) await loadGroupRespond();
  } catch (e) {
    flash(msg, false, '出错：' + e.message);
  } finally {
    if (box) box.disabled = false;
  }
}

async function setGroupRespond(gid, level, sel) {
  const msg = $('msg-group-respond');
  sel.disabled = true;
  try {
    const r = await api('/api/qq/group-respond', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: gid, level: Number(level) }),
    });
    flash(msg, r.ok, r.ok ? `${gid} 已保存` : ('保存失败：' + r.error));
    if (r.ok) await loadGroupRespond();
  } catch (e) {
    flash(msg, false, '出错：' + e.message);
  } finally {
    sel.disabled = false;
  }
}

// 作者信息页：复制 QQ 交流群号（2026-09-28 加）
function copyGroupNo() {
  const no = '1062638346';
  const el = $('about-msg');
  const done = (ok, txt) => {
    if (!el) return;
    el.textContent = txt;
    el.style.color = ok ? '#16a34a' : '#dc2626';
  };
  // ⚠️ `navigator.clipboard` 只在**安全上下文**（https 或 localhost）里有。
  //    WebUI 默认是 http://127.0.0.1:3099 ⇒ 属于 localhost，能用 ✓
  //    但如果哪天用**局域网 IP** 打开，它就没有了 ⇒ 必须给个"手动复制"的兜底提示。
  try {
    if (navigator.clipboard?.writeText) {
      navigator.clipboard
        .writeText(no)
        .then(() => done(true, `已复制群号：${no}`))
        .catch(() => done(false, `浏览器不让自动复制，手动记一下：${no}`));
    } else {
      done(false, `这个浏览器不支持一键复制，手动记一下：${no}`);
    }
  } catch {
    done(false, `复制失败，手动记一下：${no}`);
  }
}

async function renderQzone() {
  try {
    const q = await api('/api/qzone');
    if (!q.ok) return;
    const m = q.material || {};
    $('qzone-status').innerHTML =
      kv('今天已发', `${q.todayCount} / ${q.maxPerDay} 条`) +
      kv('素材', `${m.count || 0} 条（最近一条 ${m.newest || 0} 分钟前）`) +
      kv('能不能发', q.canPost ? '可以' : `暂时不行 — ${q.blockReason || ''}`);
    $('qz-enable').checked = q.enable !== false;
    $('qz-maxPerDay').value = q.maxPerDay ?? 3;
    $('qz-ugcRight').value = String(q.ugcRight ?? 1);
    if (q.recent && q.recent.length) {
      $('qzone-status').innerHTML += '<div class="mt12"><b>最近发过的：</b><br>' +
        q.recent.map(p => '· ' + esc(p.content.slice(0, 80))).join('<br>') + '</div>';
    }
  } catch {}
}

async function qzonePreview() {
  const el = $('msg-qzone');
  const btn = $('btn-qz-preview');
  btn.disabled = true;
  flash(el, null, '正在生成（会先回填群素材，可能要十几秒）…');
  try {
    const r = await api('/api/qzone/preview', { method: 'POST' });
    if (!r.ok) { flash(el, false, '出错：' + r.error); return; }
    if (!r.post) {
      flash(el, null, `它决定不发。理由：${r.reason}`);
      return;
    }
    flash(el, true, `打算发这个（类型 ${r.type}${r.face ? '，配图 ' + r.face : ''}）：`);
    $('qz-manual').value = r.content;
    await renderQzone();
  } finally { btn.disabled = false; }
}

async function qzonePost() {
  const el = $('msg-qzone');
  const btn = $('btn-qz-post');
  if (!confirm('确定要发到 QQ 空间吗？发出去就收不回来了。')) return;
  btn.disabled = true;
  flash(el, null, '正在生成并发布…');
  try {
    const r = await api('/api/qzone/post', { method: 'POST', headers: {'Content-Type':'application/json'}, body: '{}' });
    // ⚠️ 2026-09-15 深夜：接口"不发"时给的是 `skipped` / `reason`，**不是 `error`**。
    //    原来直接读 `r.error` → 界面只显示「失败： undefined」，看不出为什么没发 ✗
    //    （真实踩过：<主人> 截图「动态好像还有个问题」）
    if (r.skipped) { flash(el, null, '没有发：' + r.skipped); return; }
    if (!r.ok) { flash(el, false, '失败：' + (r.error || '（没给原因，去看日志）')); return; }
    if (!r.posted) { flash(el, null, `没有发。${r.reason || ''}`); return; }
    flash(el, true, '已发布：' + r.content.slice(0, 60));
    await renderQzone();
  } finally { btn.disabled = false; }
}

async function qzoneManualPost() {
  const el = $('msg-qzone');
  const content = $('qz-manual').value.trim();
  if (!content) { flash(el, false, '先写点内容'); return; }
  if (!confirm('确定发这条到 QQ 空间吗？')) return;
  flash(el, null, '正在发布…');
  const r = await api('/api/qzone/post', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    // 一条说说配一张（qz-face 是单选）
    body: JSON.stringify({ content, face: $('qz-face').value || null })
  });
  flash(el, r.ok, r.ok ? '已发布' : ('失败：' + r.error));
  if (r.ok) { $('qz-manual').value = ''; await renderQzone(); }
}

// ── B 站分享（2026-10-15 加）────────────────────────────────
//    **按群**设（用户：「b站分享也要分群调节」）：先选群，再调那一套 ✓
//    只发链接、只发 1 档群、默认关、没关键词不发 ✓（见 src/bili-share.js）
// ⚠️ 2026-10-16：「立刻发送」那格**这一轮渲染的是哪个群**（换群时才知道要不要换内容 ✓）
let biliNowGid = '__none__';

/* ── B站账号登录（2026-10-22 加：一键登录）──────────────────
 * 用户原话：「**可不可以纯靠 webui 完成整个 b 站登录过程，方便没有 agent 的用户操作？**」
 *
 * ⚠️ 登录要**等人扫码**（最长 10 分钟）⇒ 后端只负责"起进程 + 读状态"，
 *    界面自己**每 2 秒轮询**一次 —— 别指望一个请求挂到底（浏览器会超时、界面像卡死）✗
 * ⚠️ 走 `api()` 不走裸 `fetch`：裸 fetch 不带 `x-saki-account`，
 *    会永远操作**主号**（语音那个 tab 就踩过）✗
 */
let BL_POLL = null;

function startBiliLoginPoll() {
  if (BL_POLL) return;
  BL_POLL = setInterval(() => { loadBiliLogin(); }, 2000);
}
function stopBiliLoginPoll() {
  if (BL_POLL) { clearInterval(BL_POLL); BL_POLL = null; }
}

function renderBiliLogin(j) {
  const box = $('bl-status');
  const btn = $('bl-btn');
  if (!box) return;
  const when = j.at ? new Date(j.at).toLocaleString('zh-CN', { hour12: false }) : '';
  const who = j.uname ? `${j.uname}（uid ${j.uid}）` : (j.uid ? `uid ${j.uid}` : '');
  const skin = (bg, bd) =>
    `display:block;margin:12px 0;padding:10px 12px;border-radius:8px;background:${bg};border:1px solid ${bd}`;

  if (j.state === 'running') {
    box.style.cssText = skin('rgba(74,158,255,.10)', 'rgba(74,158,255,.4)');
    box.innerHTML = '⏳ <b>正在等你扫码…</b>（Chrome 窗口已经弹出来了，最长等 10 分钟）<br>'
      + '<span style="opacity:.75;font-size:12.5px">扫完窗口会自己关掉，这里会自动变成「已登录」</span>';
    if (btn) btn.disabled = true;
    startBiliLoginPoll();
    return;
  }
  if (btn) btn.disabled = false;
  stopBiliLoginPoll();
  if (j.state === 'ok') {
    box.style.cssText = skin('rgba(22,163,74,.12)', 'rgba(22,163,74,.45)');
    box.innerHTML = `✅ <b>已登录</b>：${esc(who)}${when ? ` · ${esc(when)}` : ''}`;
    return;
  }
  if (j.state === 'fail') {
    box.style.cssText = skin('rgba(248,81,73,.12)', 'rgba(248,81,73,.45)');
    box.innerHTML = `❌ <b>登录没成功</b>：${esc(j.err || '未知原因')}`;
    return;
  }
  if (j.state === 'stale') {
    box.style.cssText = skin('rgba(255,170,0,.12)', 'rgba(255,170,0,.45)');
    box.innerHTML = '⚠️ 上次登录<b>中断了</b>（那个 Chrome 窗口可能还开着）'
      + '<br><span style="opacity:.75;font-size:12.5px">先关掉它，再点一次「登录 / 重新登录」</span>';
    return;
  }
  box.style.cssText = skin('rgba(255,255,255,.04)', 'rgba(255,255,255,.12)');
  box.innerHTML = j.hasProfile
    ? '⬜ <b>还没确认登录态</b>（有登录目录，但没成功记录过）—— 点「登录 / 重新登录」走一遍最稳'
    : '⬜ <b>还没登录过</b> —— 点下面的「登录 / 重新登录」';
}

async function loadBiliLogin() {
  const box = $('bl-status');
  if (!box) return;
  try {
    const j = await api('/api/bili/login');
    if (!j.ok) { box.textContent = '读不到登录状态'; return; }
    renderBiliLogin(j);
  } catch (e) {
    box.textContent = '读不到登录状态：' + e.message;
  }
}

async function biliLoginStart() {
  const m = $('msg-bl');
  const btn = $('bl-btn');
  if (btn) btn.disabled = true;
  flash(m, null, '正在打开登录窗口…');
  try {
    const r = await api('/api/bili/login', { method: 'POST' });
    if (!r.ok) { flash(m, false, '起不来：' + (r.error || '')); if (btn) btn.disabled = false; return; }
    flash(m, true, r.already ? '窗口已经开着了，去 Chrome 里扫吧' : '窗口已弹出 ⇒ 去 Chrome 里扫码 / 输密码');
  } catch (e) {
    flash(m, false, '起不来：' + e.message);
    if (btn) btn.disabled = false;
    return;
  }
  await loadBiliLogin();
}

/* ── B站自动投稿（2026-10-22）──────────────────────────────
 * 用户：「在功能卡片里新增一个 B站投稿设置页，所有设置都放在里面」
 *       + 「不要新建一个页面，和其他的功能页面一样在同一个页面」
 * 设置存 `config.yml` 的 `biliPublish` 段（走 `POST /api/bili-publish` → `saveConfig`）
 * ⚠️ 事件用 `onclick=` 赋值、不用 addEventListener —— 这个函数每次切页都会重跑，
 *    addEventListener 会越绑越多（点一次保存发三次请求）✗
 */
async function renderBiliPub() {
  // ⚠️ 2026-10-22：进这个页先刷一次 B 站登录状态（它是后面所有功能的前提）
  loadBiliLogin();
  const st = $('bp-status');
  let j;
  try {
    j = await (await fetch('/api/bili-publish')).json();
  } catch (e) {
    if (st) st.textContent = '读取失败：' + e.message;
    return;
  }
  if (!j.ok) { if (st) st.textContent = '读取失败'; return; }
  const c = j.cfg, s = j.state;
  // ① 填表
  $('bp-enable').value = c.enable ? '1' : '0';
  $('bp-ws').value = c.windowStart;
  $('bp-we').value = c.windowEnd;
  $('bp-group').value = c.group || '';
  $('bp-durmax').value = c.durationMax;
  $('bp-zone').value = c.zone || '生活';
  $('bp-zone2').value = c.zone2 || '日常';
  $('bp-tags').value = (c.tags || []).join(',');
  $('bp-streak').value = c.groupMaxStreak;
  $('bp-scope').value = (c.scope || []).join('\n');
  $('bp-notify').value = c.notifyOwner ? '1' : '0';
  // ② B站评论回复（2026-10-22）—— 同一份接口返回里带着 `comments` 和 `memory`
  //    ⚠️ 字段照 `biliShare` 那套：每天条数 / 时间段 / 两条间隔 / 关键词
  const cm = j.comments || {};
  if ($('bc-enable')) $('bc-enable').value = cm.enable ? '1' : '0';
  if ($('bc-check')) $('bc-check').value = cm.checkEveryMinutes ?? 5;
  if ($('bc-max')) $('bc-max').value = cm.maxPerRun ?? 3;
  if ($('bc-status')) {
    const m = j.memory || {};
    const by = m.by || {};
    const today = (cm && cm.todayCount) || 0;
    $('bc-status').innerHTML =
      '短期记忆：<b>' + (m.total || 0) + '</b> 条（视频 ' + (by.video || 0) +
      ' · B站评论 ' + (by['bili-comment'] || 0) + ' · QQ ' + (by.qq || 0) +
      '），只保留最近 ' + (m.keepHours || 48) + ' 小时' +
      (today ? '｜今天已回 ' + today + ' 条' : '');
  }
  // ③ B站主动评论（2026-10-21）—— 同一份接口返回里带着 `proactive` / `proactiveState`
  const pr = j.proactive || {};
  const prs = j.proactiveState || {};
  if ($('bp2-enable')) $('bp2-enable').value = pr.enable ? '1' : '0';
  if ($('bp2-min')) $('bp2-min').value = pr.minPerDay ?? 1;
  if ($('bp2-max')) $('bp2-max').value = pr.maxPerDay ?? 2;
  if ($('bp2-interval')) $('bp2-interval').value = pr.intervalMinutes ?? 20;
  if ($('bp2-start')) $('bp2-start').value = pr.startHour ?? 10;
  if ($('bp2-end')) $('bp2-end').value = pr.endHour ?? 22;
  if ($('bp2-keywords')) $('bp2-keywords').value = (pr.keywords || []).join('\n');
  if ($('bp2-status')) {
    $('bp2-status').innerHTML = pr.enable
      ? '<b style="color:#3fb950">● 已开启</b> · 今天 ' + (prs.countToday || 0) + '/' + (prs.targetToday || 0) +
        ' 条 · 关键词 ' + (pr.keywords || []).length + ' 个'
      : '<b style="color:#8b98a5">○ 已关闭</b>';
  }
  // 用户：「要**显示出来发送的视频链接**」—— 最近发过的一条条列出来，链接可点
  if ($('bp2-recent')) {
    const rs = prs.recent || [];
    if (!rs.length) $('bp2-recent').innerHTML = '<span class="d">还没发过</span>';
    else {
      $('bp2-recent').innerHTML = '<div style="margin-bottom:4px">最近发过的：</div>' + rs.map(function (x) {
        const t = new Date(x.at || Date.now());
        const when = (t.getMonth() + 1) + '/' + t.getDate() + ' ' + String(t.getHours()).padStart(2, '0') + ':' + String(t.getMinutes()).padStart(2, '0');
        const ok = x.ok ? '<b style="color:#3fb950">成功</b>' : '<b style="color:#f85149">失败</b>';
        const link = x.url ? '<a href="' + x.url + '" target="_blank" rel="noopener" style="color:#4a9eff">' + (x.bvid || '链接') + '</a>' : '';
        return '<div style="margin:2px 0">' + when + ' · ' + ok + ' · ' + link +
          (x.title ? ' · ' + String(x.title).slice(0, 30) : '') +
          (x.text ? '<div class="d" style="margin-left:10px">「' + String(x.text).slice(0, 60) + '」</div>' : '') + '</div>';
      }).join('');
    }
  }
  // ② 状态条
  if (st) {
    st.innerHTML =
      '<b style="color:' + (c.enable ? '#3fb950' : '#8b98a5') + '">' +
      (c.enable ? '● 已开启' : '○ 已关闭') + '</b>' +
      ' · ' + (s.todayDone ? '今天已经做过了' : '今天还没做，计划 ' + s.nextAt) +
      ' · 连续群聊 ' + s.streakGroup + '/' + s.groupMaxStreak + ' 天' +
      (s.running ? ' · <b style="color:#4a9eff">正在做…</b>' : '');
  }
  // ③ 最近记录
  const hs = s.history || [];
  const hb = $('bp-history');
  if (hb) {
    if (!hs.length) hb.innerHTML = '<span class="d">还没有记录</span>';
    else {
      hb.innerHTML = hs.map(function (x) {
        const when = String(x.at || '').slice(5, 16).replace('T', ' ');
        const src = x.source === 'group' ? '群聊' : x.source === 'custom' ? '自定义' : '自制';
        const ok = x.ok
          ? '<b style="color:#3fb950">成功</b>'
          : '<b style="color:#f85149">失败</b>';
        return '<div style="padding:4px 0;border-bottom:1px solid rgba(127,127,127,.15)">' +
          when + ' · ' + src + ' · ' + (x.title || x.topic || x.why || '') + ' · ' + ok + '</div>';
      }).join('');
    }
  }
  bpBindSave(); // ⚠️ 必须在这里绑（脚本块在 DOM 之前执行，外面绑会拿到 null）
}

// ⚠️ 必须**在 renderBiliPub 里调用**：这个脚本块在 DOM 之前执行，
//    直接在外面 `$('bp-save').onclick = …` 拿到的是 null（面板还没解析）✗
//    用 `onclick =` 覆盖式绑定 ⇒ 重复调用也只有一个监听 ✓
function bpBindSave() {
$('bp-save') && ($('bp-save').onclick = async function () {
  this.disabled = true;
  const body = {
    cfg: {
      enable: $('bp-enable').value === '1',
      windowStart: $('bp-ws').value,
      windowEnd: $('bp-we').value,
      group: $('bp-group').value,
      durationMax: Number($('bp-durmax').value),
      zone: $('bp-zone').value,
      zone2: $('bp-zone2').value,
      tags: $('bp-tags').value,
      groupMaxStreak: Number($('bp-streak').value),
      scope: $('bp-scope').value,
      notifyOwner: $('bp-notify').value === '1',
    },
    // ⚠️ 2026-10-22：B站评论回复也在这页存（字段照 biliShare：每天条数/时间段/间隔/关键词）
    comments: {
      enable: $('bc-enable') ? $('bc-enable').value === '1' : false,
      checkEveryMinutes: Number(($('bc-check') || {}).value) || 5,
      maxPerRun: Number(($('bc-max') || {}).value) || 3,
    },
    // ⚠️ 2026-10-21：B站**主动评论**（去别人视频下发）也在这页存
    proactive: {
      enable: $('bp2-enable') ? $('bp2-enable').value === '1' : false,
      keywords: ($('bp2-keywords') || {}).value || '',
      minPerDay: Number(($('bp2-min') || {}).value) || 1,
      maxPerDay: Number(($('bp2-max') || {}).value) || 2,
      intervalMinutes: Number(($('bp2-interval') || {}).value) || 20,
      startHour: Number(($('bp2-start') || {}).value) || 10,
      endHour: Number(($('bp2-end') || {}).value) || 22,
    },
  };
  try {
    const r = await (await fetch('/api/bili-publish', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    })).json();
    var st2=$('bp-status');
    if (r.ok) {
      // ⚠️ 先 render 再写提示 —— renderBiliPub 会重设整个 innerHTML，
      //    反过来写会把「已保存 ✓」当场冲掉（2026-10-22 实测：存成功了却看着像没存）✗
      await renderBiliPub();
      var st4=$('bp-status');
      if(st4) st4.innerHTML='<b style="color:#3fb950">已保存 ✓</b> · ' + st4.innerHTML;
    } else if (st2) {
      st2.innerHTML='<b style="color:#f85149">保存失败：' + (r.error||'') + '</b>';
    }
  } catch (e) { var s2=$('bp-status'); if(s2) s2.textContent='保存失败：'+e.message; }
  this.disabled = false;
});

// ⚠️ 2026-10-21：**主动评论卡片**的两个按钮
//    · 保存：转给上面那个 bp-save（同一套 POST，别写第二份逻辑）
//    · 立刻发一条：POST /api/bili-proactive/now，1~3 分钟出结果，靠轮询 recent 看链接
$('bp2-save') && ($('bp2-save').onclick = function () { const b = $('bp-save'); if (b) b.click(); });
$('bp2-now') && ($('bp2-now').onclick = async function () {
  this.disabled = true;
  const raw = String(($('bp2-manual') || {}).value || '').trim();
  const bvid = (raw.match(/BV[0-9A-Za-z]+/) || [''])[0];
  const st = $('bp2-recent');
  if (st) st.innerHTML = '<b style="color:#4a9eff">正在去发（开浏览器 + 看视频 + 写，1~3 分钟）…</b>';
  try {
    const r = await (await fetch('/api/bili-proactive/now', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(bvid ? { bvid: bvid } : {}),
    })).json();
    if (!r.ok) { if (st) st.innerHTML = '<b style="color:#f85149">没能开始：' + (r.error || '') + '</b>'; }
    else {
      // 每 8 秒看一次，最多看 4 分钟（结果一出来就停）
      let n = 0;
      const timer = setInterval(async function () {
        n++;
        try { await renderBiliPub(); } catch (e) { /* ignore */ }
        if (n >= 30) clearInterval(timer);
      }, 8000);
    }
  } catch (e) { if (st) st.textContent = '没能开始：' + e.message; }
  this.disabled = false;
});
$('bp-run') && ($('bp-run').onclick = async function () {
  this.disabled = true;
  try {
    const r = await (await fetch('/api/bili-publish/run', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ topic: $('bp-topic').value, publish: !$('bp-draft').checked }),
    })).json();
    var st3=$('bp-status');if(st3)st3.innerHTML=r.ok?'<b style="color:#4a9eff">已开始，3~5 分钟后再来看记录</b>':'<b style="color:#f85149">没能开始：' + (r.error||'') + '</b>';
    if (r.ok) setTimeout(renderBiliPub, 3000);
  } catch (e) { var s3=$('bp-status'); if(s3) s3.textContent='没能开始：'+e.message; }
  this.disabled = false;
});
// ⚠️ 2026-10-22：**评论回复那张卡片自己也有一个「保存设置」按钮**（用户截图报的：
//    「连保存按钮都没有，怎么保存啊？」—— 上一版只有上面「内容来源」那张有）
//    ⇒ 直接转给上面那个按钮，两处是**同一个动作**（不复制一份逻辑，免得以后改漏一处）
$('bp-save2') && ($('bp-save2').onclick = function () { const b = $('bp-save'); if (b) b.click(); });
} // ← bpBindSave 的收尾（漏了这个 } 会让整个 script 块语法错误、页面所有 JS 全挂 ✗）

async function renderVoice() {
  const st = $('vc-status');
  try {
    // ⚠️ 必须走 `api()`（带 `x-saki-account` 头），裸 fetch 会读成主号的配置 ✗
    const j = await api('/api/voice');
    if (!j.ok) { if (st) st.textContent = '读取失败'; return; }
    if ($('vc-enable')) $('vc-enable').value = j.cfg.enable ? '1' : '0';
    if ($('vc-poke')) $('vc-poke').value = j.cfg.pokeVoice ? '1' : '0';
    const sel = $('vc-ref');
    if (sel) {
      const cur = j.cfg.ref || '';
      sel.innerHTML = '<option value="">（默认）' +
        (j.current && !cur ? ' ' + j.current : '') + '</option>' +
        (j.voices || []).map(function (v) {
          return '<option value="' + v.name + '">' + v.name + (v.def ? '（内置默认）' : '') + '</option>';
        }).join('');
      sel.value = cur;
      if (sel.value !== cur) sel.value = '';
    }
    if (st) {
      st.innerHTML = '实际在用：<b>' + (j.current || '?') + '</b>' +
        (j.cfg.enable ? '' : ' · <b style="color:#f85149">总开关关着</b>') +
        ' · 可选音色 ' + (j.voices || []).length + ' 个';
    }
  } catch (e) {
    if (st) st.textContent = '读取失败：' + e.message;
  }
}

$('vc-save') && ($('vc-save').onclick = async function () {
  this.disabled = true;
  try {
    // ⚠️ 同上：走 `api()`，否则存到主号去
    const r = await api('/api/voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enable: $('vc-enable').value === '1',
        pokeVoice: $('vc-poke').value === '1',
        ref: $('vc-ref').value || '',
      }),
    });
    await renderVoice();
    const st = $('vc-status');
    if (st) st.innerHTML = (r.ok ? '<b style="color:#3fb950">已保存 ✓</b> · ' : '<b style="color:#f85149">保存失败：' + (r.error || '') + '</b> · ') + st.innerHTML;
  } catch (e) {
    const st = $('vc-status');
    if (st) st.textContent = '保存失败：' + e.message;
  }
  this.disabled = false;
});

// ⚠️ 兜底：页面加载后**先渲染一次**（不等用户点 tab）
//    ⚠️ 2026-10-22：原来这里还挂了一个 `[data-tab="biliPub"], [data-tab="biliCmt"]` 的点击兜底，
//       但那两个 tab 已经合并进 `bili` 了 ⇒ 选择器永远匹配不到空转；切页钩子里已经会调
//       `renderBiliPub()`，所以那段点击兜底删掉，只留下面这一句初次渲染。
setTimeout(() => { renderBiliPub().catch(() => {}); }, 1200);
/* ⚠️⚠️ 2026-10-21：语音页的填充 —— **内联、不依赖任何外部函数**
 *   试过三版都没跑起来（`if (tab==='voice') renderVoice()` / `setTimeout` / `vcBoot`），
 *   连报错都不出来 ⇒ 说明**那几行顶层代码压根没执行**（不是函数的问题）。
 *   ⇒ 最后这版：**挂 `window.load` + 立即执行 + 3 秒轮询**三重保险，
 *     而且逻辑**全部内联**（不再调 renderVoice），排除一切作用域/时序可能 ✓ */
(function () {
  var filled = 0;
  function fillVoice(reason) {
    if (filled > 3) return;
    filled++;
    var sel = document.getElementById('vc-ref');
    var st = document.getElementById('vc-status');
    if (!sel) { if (st) st.textContent = '（' + reason + '找不到 vc-ref 元素）'; return; }
    if (sel.options && sel.options.length > 1) return;   // 已经填过了
    /* ⚠️⚠️ 2026-10-21 真 bug（用户：「谷雨这里还是开着的啊」「你就不能多检查一下吗」）：
     *   这里原来用的是**裸 `fetch('/api/voice')`** —— 它**不带 `x-saki-account` 头**，
     *   而界面的"切号"就是靠那个头让服务端**转发给对应号的进程**的（见 `api()` 包装）
     *   ⇒ 裸 fetch 永远打到**本机那个号**（主号）⇒ **在谷雨界面看到的其实是主号的配置** ✗✗
     *   ⇒ 必须走 `api()` 包装 ✓
     */
    api('/api/voice')
      .then(function (j) {
        if (!j || !j.ok) { if (st) st.textContent = '（' + reason + '接口返回不 ok）'; return; }
        if (document.getElementById('vc-enable')) document.getElementById('vc-enable').value = j.cfg.enable ? '1' : '0';
        if (document.getElementById('vc-poke')) document.getElementById('vc-poke').value = j.cfg.pokeVoice ? '1' : '0';
        var cur = j.cfg.ref || '';
        sel.innerHTML = '<option value="">（默认）' + (j.current && !cur ? ' ' + j.current : '') + '</option>' +
          (j.voices || []).map(function (v) {
            return '<option value="' + v.name + '">' + v.name + (v.def ? '（内置默认）' : '') + '</option>';
          }).join('');
        sel.value = cur;
        if (sel.value !== cur) sel.value = '';
        if (st) {
          st.innerHTML = '实际在用：<b>' + (j.current || '?') + '</b>' +
            (j.cfg.enable ? '' : ' · <b style="color:#f85149">总开关关着</b>') +
            ' · 可选音色 ' + (j.voices || []).length + ' 个';
        }
      })
      .catch(function (e) { if (st) st.textContent = '（' + reason + '出错：' + (e && e.message ? e.message : e) + '）'; });
  }
  // ① 立即试一次  ② load 后再试  ③ 每 1.2 秒补 3 次（防脚本晚到）
  fillVoice('立即');
  window.addEventListener('load', function () { fillVoice('load'); });
  setTimeout(function () { fillVoice('1.2s'); }, 1200);
  setTimeout(function () { fillVoice('3s'); }, 3000);
  // ④ 点「语音」这个 tab 时也补一次
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-tab="voice"]') : null;
    if (b) setTimeout(function () { filled = 0; fillVoice('切页'); }, 80);
  }, true);
  // ⑤ 保存按钮：保存完再刷一次
  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('#vc-save') : null;
    if (!b) return;
    e.preventDefault();
    var sel = document.getElementById('vc-ref');
    var st = document.getElementById('vc-status');
    // ⚠️ 同上：**必须走 `api()`**，不然保存会写到主号去（切号等于白切）✗
    api('/api/voice', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        enable: document.getElementById('vc-enable').value === '1',
        pokeVoice: document.getElementById('vc-poke').value === '1',
        ref: sel ? (sel.value || '') : '',
      }),
    }).then(function (r) {
      filled = 0;
      fillVoice('保存后');
      if (st) st.innerHTML = (r && r.ok ? '<b style="color:#3fb950">已保存 ✓</b> · ' : '<b style="color:#f85149">保存失败：' + ((r && r.error) || '') + '</b> · ') + st.innerHTML;
    }).catch(function (err) { if (st) st.textContent = '保存失败：' + (err && err.message ? err.message : err); });
  }, true);
})();

async function renderBili() {
  const box = $('bili-status');  try {
    // ① 先填"哪个群"那个下拉（跟「日常事件」页同一个来源：/api/state 的 life.status.targets）
    const st = await api('/api/state');
    // ⚠️ 2026-10-15 改：用 `targetsAll`（**1 档群**，不管日常事件开没开）——
    //    原来用 `targets` ⇒ 把日常事件关掉的 1 档群**在下拉里看不到**（用户报的）✗
    const gids = (st.life?.status?.targetsAll || st.life?.status?.targets || []).map(String);
    const sel = $('bili-group');
    if (sel) {
      const keep = String(sel.value || localStorage.getItem('bili-group') || '');
      // ⚠️ 2026-10-22：统一文案「群 + 群号 + 名字」（原来这里连"群"字都没有，就一个裸号码）
      await ensureGroupNames();
      sel.innerHTML = gids.map((g) => `<option value="${esc(g)}">${esc(groupLabel(g))}</option>`).join('');
      if (keep && gids.includes(keep)) sel.value = keep;
    }
    const gid = String(sel?.value || gids[0] || '');
    if (!gid) {
      box.textContent = '现在没有 1 档群 —— 先去「群与触发」把某个群调成 1 档，这里才能按群设';
      return;
    }
    const r = await api('/api/bili-share?groupId=' + encodeURIComponent(gid));
    // ⚠️ 2026-10-22：这套按群设置**又搬回 B站页了**（用户：「A挪回b站页，按群参数里边这块不是很需要」）。
    //    ⚠️ 只留这一份 —— 别再往「按群参数」加回去，两个入口写同一个 biliShare[群]、互相覆盖。
    const c = r.cfg || {};
    $('bili-enable').checked = !!c.enable;
    $('bili-keywords').value = (c.keywords || []).join('\n');
    $('bili-min').value = c.minPerDay ?? 1;
    $('bili-max').value = c.maxPerDay ?? 1;
    $('bili-sh').value = c.startHour ?? 9;
    $('bili-eh').value = c.endHour ?? 23;
    $('bili-cool').value = c.cooldownMinutes ?? 240;
    $('bili-results').value = c.maxResults ?? 8;
    $('bili-chance').value = c.chancePercent ?? 50;
    $('bili-deny').value = c.deny || '';
    const s = r.status || {};
    const next = s.next || {};
    box.innerHTML =
      '<div class="kv"><b>这个群今天</b><span>' + (s.fired ?? 0) + ' / ' + (s.target ?? 0) + ' 条</span></div>' +
      '<div class="kv"><b>现在能不能发</b><span>' + (next.due ? '能 ✓' : '不能：' + (next.why || '')) + '</span></div>' +
      '<div class="kv"><b>发过几条（全局去重池）</b><span>' + (s.sentCount ?? 0) + '</span></div>' +
      '<div class="kv"><b>已发记录保留</b><span>' + (s.sentKeepDays ?? 60) + ' 天</span></div>';
    // ⚠️⚠️ 2026-10-16 加（用户：「**独立视频发送那里的关键词框还是没有被保存**」）——
    //    把"立刻发送"那格**上次填的**填回去（**按群**记的 ✓）
    //    ⚠️ 正打着字的时候不许盖（焦点在框里就不动 ✗）
    //    ⚠️ **换了群** ⇒ 换成那个群自己那份（服务端存过就用它，没存过用本地兜底那份 ✓）
    try {
      const kwEl = $('bili-now-kw');
      const tkEl = $('bili-now-take');
      const saved = String(s.nowKeywords ?? '');
      const localGet = (k) => {
        try {
          return localStorage.getItem(k);
        } catch {
          return null;
        }
      };
      if (kwEl && document.activeElement !== kwEl) {
        if (biliNowGid !== gid) kwEl.value = saved || String(localGet('bili-now-kw:' + gid) ?? '');
        else if (!String(kwEl.value || '').trim() && saved) kwEl.value = saved;
      }
      if (tkEl) {
        if (typeof s.nowTake === 'boolean') tkEl.checked = s.nowTake;
        else if (biliNowGid !== gid) {
          const lt = localGet('bili-now-take:' + gid);
          if (lt !== null) tkEl.checked = lt === '1';
        }
      }
      biliNowGid = gid;
    } catch {}
  } catch (e) {
    box.textContent = '读不到：' + e.message;
  }
}

/**
 * ⚠️⚠️ 2026-10-16 加（用户：「**独立视频发送那里的关键词框还是没有被保存**」）——
 * 那格敲完**自动存**（防抖 700ms ⇒ `POST /api/bili-share/now`）⇒ 刷新、换浏览器、重启都还在 ✓
 * ⚠️ 存的只是这一格，**不动**上面那份"自动发送"的设置 ✓
 * ⚠️ 再往 localStorage 也压一份（接口万一断了也不至于丢字 ✓）
 */
let biliNowTimer = null;
function saveBiliNowSoon() {
  const gid = String($('bili-group')?.value || '');
  if (!gid) return;
  const kw = String($('bili-now-kw')?.value || '');
  const take = !!$('bili-now-take')?.checked;
  try {
    localStorage.setItem('bili-now-kw:' + gid, kw);
    localStorage.setItem('bili-now-take:' + gid, take ? '1' : '0');
  } catch {}
  if (biliNowTimer) clearTimeout(biliNowTimer);
  biliNowTimer = setTimeout(async () => {
    const el = $('msg-bili-now');
    try {
      const r = await api('/api/bili-share/now', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ groupId: gid, keywords: kw, take }),
      });
      if (el) flash(el, r.ok !== false, r.ok === false ? '没存上：' + (r.error || '') : '记住了 ✓');
    } catch (e) {
      // ⚠️⚠️ 2026-10-16（用户截图）：进程还是旧代码时没这个接口 ⇒ 服务端回的是纯文本
      //    `Not found`（不是 JSON）⇒ `api()` 解析失败抛错 ⇒ 界面弹一个吓人的红字 ✗
      //    ⇒ 这种"服务端还没跟上"的情况**不算保存失败**：本地那一份已经写进去了，
      //      重启之后打开页面会自动用本地那份填回来、下一次敲字就存到服务端了 ✓
      const soft = /Not found|Unexpected token|not valid JSON|404/i.test(String(e?.message ?? ''));
      if (el) {
        flash(
          el,
          soft,
          soft ? '先存在本地了 ✓（服务端这个接口要重启才带上，重启后自动补上）' : '没存上（本地留了一份）：' + e.message,
        );
      }
    }
  }, 700);
}

/**
 * 2026-10-22：保存这个群的自动分享设置（从「按群参数」搬回来那套）。
 * ⚠️ 字段要**全**提交 —— 旧版只提交了 enable/keywords/cooldown/chance/deny，
 *    条数和时段三个改了也存不上（界面显示改了、刷新又回去）。
 */
async function saveBili() {
  const el = $('msg-bili');
  const gid = String($('bili-group')?.value || '');
  if (!gid) return flash(el, false, '先选个群（这是按群设的）');
  try {
    const r = await api('/api/bili-share', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        groupId: gid,
        enable: $('bili-enable').checked,
        keywords: $('bili-keywords').value,
        minPerDay: Number($('bili-min').value),
        maxPerDay: Number($('bili-max').value),
        startHour: Number($('bili-sh').value),
        endHour: Number($('bili-eh').value),
        cooldownMinutes: Number($('bili-cool').value),
        maxResults: Number($('bili-results').value),
        chancePercent: Number($('bili-chance').value),
        deny: $('bili-deny').value,
      }),
    });
    flash(el, r.ok, r.ok ? `已保存到群 ${gid} 并生效` : '保存失败：' + r.error);
    if (r.ok) renderBili();
  } catch (e) {
    flash(el, false, '保存失败：' + e.message);
  }
}

// ⚠️ 立刻发送：跳过"时段/冷却"，但仍排除发过的、仍记账 ✓ **只发选中的那个群**
/**
 * ⚠️⚠️ 2026-10-16 改（用户：「**把立即发送一条独立出来，单独给它加个关键词框，
 *   这样就不用动自动发送那里的设置了**」+「**再独立加一个是否配 bot 自己评论的选框**」）——
 * 手动试一条：**临时关键词** + **要不要带她那句评论**，都只影响这一次 ✓
 * （原来它跟自动设置共用一份关键词 ⇒ 想试一个词就得改自动设置 ✗）
 */
async function sendBiliNow() {
  const el = $('msg-bili-now') || $('msg-bili');
  const gid = String($('bili-group')?.value || '');
  if (!gid) return flash(el, false, '先选个群（这是按群设的）');
  const kw = String($('bili-now-kw')?.value || '').trim();
  const take = !!$('bili-now-take')?.checked;
  el.textContent = '正在挑一条…';
  try {
    const r = await api('/api/bili-share/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ groupId: gid, keywords: kw, take }),
    });
    flash(el, r.ok, r.ok ? '已发出：' + (r.url || '') : '没发成：' + (r.error || r.why || '未知'));
    renderBili();
  } catch (e) {
    flash(el, false, '发失败：' + e.message);
  }
}

async function saveQzone() {  const el = $('msg-qzone-cfg');
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ qzone: {
      enable: $('qz-enable').checked,
      auto: $('qz-auto').checked,
      cooldownMs: Number($('qz-cooldownHours').value) * 3600000,
      ugcRight: Number($('qz-ugcRight').value),
      // ⚠️ 2026-09-28：**只传要改的键** —— 后端对 `qzone.comment` 做了**一层深合并**
      //    （见 src/webui.js 的 saveConfig），所以 days / maxPerDay / intervalMs
      //    不会被这次保存冲掉。
      comment: { enable: $('qz-comment').checked },
    }})
  });
  flash(el, r.ok, r.ok ? '已保存并生效' : ('保存失败：' + r.error));
  if (r.ok) await reloadAll();
}
// 保存灵敏度
async function saveRespondTo() {
  const el = $('msg-respond');
  const sel = [...document.querySelectorAll('input[name=respondTo]')].find(r => r.checked);
  if (!sel) { flash(el, false, '先选一个档次'); return; }
  const level = Number(sel.value);
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    // ⚠️ 2026-10-22：连 `groupChat`（群聊应答总开关）一起存 —— 它从「私聊名单」卡挪到了这张卡里。
    body: JSON.stringify({ trigger: { respondTo: level, groupChat: $('trigger-groupChat')?.checked } })
  });
  const names = {1:'① 有能回答的就回', 2:'② 只回服务器/聊到它的', 3:'③ 只有 @ 才回'};
  flash(el, r.ok, r.ok ? `已切到 ${names[level]}，立即生效` : ('保存失败：' + r.error));
  if (r.ok) reloadAll();
}

// ── 收紧度滑块（2026-09-13 加，用户要求；**只对灵敏度 ① 生效**）──────
// 拖动时实时给出"这意味着什么"的说明，让人不用猜数字。
// ⚠️ 2026-10-22 删掉一整块死函数：`onStrictInput` / `fillStrictForGroup` /
//    `fillStrictValueForSelected` / `saveStrictForGroup` / `clearStrictForGroup`。
//    这五个是「收紧度」还长在「群与触发」页时的那套控件逻辑（选群 + 滑块 + 保存/还原），
//    控件搬去「按群参数」换成滑块之后它们就只剩彼此调用、**没有一个外部入口**了
//    （`saveStrictForGroup` / `clearStrictForGroup` 连按钮都没了）。
//    ⚠️ 别想着"留着备用"—— 它们操作的是 `#strict-group` / `#strictness` 这些**已经不存在**的元素，
//       哪天被谁调一次就是 `null.value` 报错。
function onStrictInput() {
  const v = Number($('strictness').value);
  const d = $('strict-desc');
  let txt, color;
  if (v <= 15) {
    txt = '它会比较爱说话 —— 只要接得上就接。群友可能觉得它话有点多。';
    color = '#c2410c';
  } else if (v <= 40) {
    txt = '偏活跃。服务器问题照答，闲聊里能接的也会接。';
    color = '#a16207';
  } else if (v <= 65) {
    txt = '平衡（推荐）。服务器问题、求助、聊到它的会答；普通闲聊一般不插嘴。';
    color = '#15803d';
  } else if (v <= 85) {
    txt = '偏安静。只有明确需要它的时候才开口，闲聊基本不参与。';
    color = '#1d4ed8';
  } else {
    txt = '很克制。几乎只在"不回答就不对"的时候才说话（服务器问题、求助）。';
    color = '#1e3a8a';
  }
  if (d) d.innerHTML = '<b style="color:' + color + '">' + v + '</b> · ' + txt;
}

/**
 * ⚠️ 2026-10-22：这一组（收紧度按群调）中午被我删过 104 行（`90ce2c1`），
 *    因为当时判断"控件搬去按群参数、这里没入口了"。
 *    后来用户说「这块还是挪回去」—— 收紧度属于"她怎么说话"，属于「群与触发」，
 *    不属于"事件/剧情"。⇒ 原样恢复，按群参数里那个 `gp-chat-strict` 删掉了。
 */

/** 把 1 档群填进下拉框，并把选中的群现在生效的收紧度回填 */
async function fillStrictForGroup() {
  const sel = $('strict-group');
  if (!sel) return;
  try {
    // ⚠️ 2026-10-22 修（用户：「下拉没新群」）：原来这里是 `STATE || (await api('/api/state'))` ——
    //    `STATE` 是页面加载时拉的**缓存**，机器人后来新加的群根本不在里面 ⇒ 下拉里看不到新群。
    //    现在每次都重新拉（切页 / 切群才调，不频繁）。
    const st = await api('/api/state');
    const lv = st.config?.trigger?.groupRespondTo || {};
    const allow = (st.config?.trigger?.allowGroups || []).map(String);
    const gids = Object.keys(lv)
      .filter((g) => Number(lv[g]) === 1 && (!allow.length || allow.includes(g)))
      .sort();
    const keep = sel.value || localStorage.getItem('strict-group') || '';
    // ⚠️ 2026-10-22：统一文案「群 + 群号 + 名字」（`groupLabel()`）
    await ensureGroupNames();
    sel.innerHTML = gids.length
      ? gids.map((g) => `<option value="${esc(g)}">${esc(groupLabel(g))}</option>`).join('')
      : '<option value="">（现在没有 1 档群）</option>';
    if (keep && gids.includes(keep)) sel.value = keep;
    await fillStrictValueForSelected();
  } catch {}
}

/** 回填"选中的那个群"现在生效的收紧度 —— 滑块要跟着动 */
async function fillStrictValueForSelected() {
  const sel = $('strict-group');
  if (!sel) return;
  const gid = String(sel.value || '').trim();
  if (gid) localStorage.setItem('strict-group', gid);
  const slider = $('strictness');
  if (!gid) {
    if (slider) slider.value = '50';
    onStrictInput();
    return;
  }
  try {
    const r = await api(`/api/group-params?groupId=${encodeURIComponent(gid)}`);
    const raw = r?.overrides?.chat?.strictness;
    const has = raw !== undefined && raw !== null && raw !== '';
    if (slider) slider.value = String(has ? Number(raw) : 50);
  } catch {
    if (slider) slider.value = '50';
  }
  onStrictInput();
}

async function saveStrictForGroup() {
  const el = $('msg-strict-group');
  const gid = String($('strict-group')?.value || '').trim();
  if (!gid) return flash(el, false, '先选一个 1 档群');
  const v = Number($('strictness')?.value ?? 50);
  const r = await api('/api/group-params', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId: gid, patch: { chat: { strictness: v } } }),
  });
  flash(el, r.ok, r.ok ? `群 ${gid} 的收紧度 = ${v}，立即生效` : '失败：' + (r.error || ''));
  if (r.ok) fillStrictValueForSelected();
}

async function clearStrictForGroup() {
  const el = $('msg-strict-group');
  const gid = String($('strict-group')?.value || '').trim();
  if (!gid) return;
  const r = await api('/api/group-params', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groupId: gid, patch: { chat: { strictness: null } } }),
  });
  flash(el, r.ok, r.ok ? `群 ${gid} 已还原成默认（50）` : '失败：' + (r.error || ''));
  if (r.ok) fillStrictValueForSelected();
}


async function saveStatus() {
  const el = $('msg-status');
  const r = await api('/api/config', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ status: {
      enable: $('status-enable').checked,
      host: $('status-host').value.trim(),
      displayName: $('status-displayName').value.trim(),
      cacheSeconds: Number($('status-cacheSeconds').value),
    }})
  });
  flash(el, r.ok, r.ok ? '已保存并生效' : ('保存失败：' + r.error));
  if (r.ok) reloadAll();
}

async function testServer() {
  const el = $('msg-status');
  flash(el, null, '查询中…');
  const r = await api('/api/test-server', { method: 'POST' });
  flash(el, r.ok, r.text);
}

// ── 表情包 ──
let FACES = [];

function renderFaces() {
  FACES = STATE?.faces ?? [];
  const unset = FACES.filter(f => !f.when || f._未完善).length;
  $('face-count').textContent = FACES.length + ' 张' + (unset ? ` · ${unset} 张待完善` : '');
  $('faces').innerHTML = FACES.map(f => {
    const need = !f.when || f._未完善;
    return `
    <div class="face" style="${need ? 'border-color:#f59e0b;background:#fffbeb' : ''}">
      <img src="/library/${encodeURIComponent(f.file)}" alt="${esc(f.tag)}" loading="lazy">
      <div class="body">
        <div class="tag">[表情:${esc(f.tag)}]${f.variantCount > 1 ? ` · ${f.variant}/${f.variantCount}` : ''}${need ? ' ⚠️' : ''}</div>
        ${f.who ? `<div class="when" style="color:#374151">${esc(f.who)}</div>` : ''}
        <div class="when">${esc(f.when || '（还没填「适用场合」——不填的话它不会用这张）')}</div>
        <div class="ops">
          <button onclick="editFace('${esc(f.tag)}')">${need ? '去完善' : '编辑'}</button>
          <button onclick="delFace('${esc(f.tag)}')" style="color:#dc2626">删除</button>
        </div>
      </div>
    </div>`;
  }).join('') || '<div style="color:#6b7280">还没有表情，上面拖图片进来</div>';
  return Promise.resolve();
}

// 扫 library/ 目录，把没登记的图补进来；发现缺注释的就问要不要自动补
window.scanFaces = async () => {
  const el = $('msg-face');
  const btn = $('btn-scan');
  btn.disabled = true;
  flash(el, null, '正在扫描 library/ 目录…');
  try {
    const r = await api('/api/faces/scan', { method: 'POST' });
    if (!r.ok) { flash(el, false, '失败：' + r.error); return; }
    const parts = [];
    if (r.added.length) parts.push(`新增 ${r.added.length} 张`);
    if (r.missing.length) parts.push(`清掉 ${r.missing.length} 条失效记录`);
    if (r.broken.length) parts.push(`删除 ${r.broken.length} 张重复图`);

    // 有缺注释的 → 问一句要不要让机器人看图自动补（用户要求：跟更新表情库集成）
    if (r.unannotatedCount > 0) {
      flash(el, true, (parts.length ? parts.join('；') + '。' : '') +
        `发现 ${r.unannotatedCount} 张缺注释（谁/什么时候用）。`);
      const yes = confirm(
        `有 ${r.unannotatedCount} 张表情还没有注释（"图里是谁"和"什么时候用"）。\n\n` +
        `要现在让机器人看图自动补吗？\n` +
        `· 每张约 5~10 秒（要过一次视觉模型）\n` +
        `· 一次处理 10 张，做完会显示进度\n` +
        `· 中途可以随时关掉页面，已完成的会保存\n\n` +
        `（也可以稍后在界面上手动填）`,
      );
      if (yes) await annotateFaces();
      return;
    }

    flash(el, true, parts.length ? parts.join('；') + '。' : '没有变化，表情库是最新的。');
  } catch (e) {
    flash(el, false, '出错：' + e.message);
  } finally {
    btn.disabled = false;
    await reloadAll();
  }
};

// 分批补注释，边做边显示进度（每批 10 张，避免单个请求挂太久）
window.annotateFaces = async () => {
  const el = $('msg-face');
  const btn = $('btn-annotate');
  if (btn) btn.disabled = true;
  let total = 0;
  let done = 0;
  let failed = 0;
  try {
    for (let round = 0; round < 50; round++) {
      flash(el, null, `正在看图补注释… 已完成 ${done} 张${total ? ` / ${total}` : ''}（每张约 5~10 秒）`);
      const r = await api('/api/faces/annotate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ batch: 10 }),
      });
      if (!r.ok) { flash(el, false, '出错：' + r.error); break; }
      if (r.message) { flash(el, true, r.message); break; }
      done += (r.added || []).length;
      failed += (r.failed || []).length;
      if (!total) total = done + r.remaining;
      await reloadAll();
      if (r.done) {
        flash(el, failed ? null : true,
          `补完了：成功 ${done} 张${failed ? `，失败 ${failed} 张` : ''}。` +
          (failed ? '失败的可以手动填，或者再点一次重试。' : ''));
        break;
      }
    }
  } catch (e) {
    flash(el, false, '出错：' + e.message);
  } finally {
    if (btn) btn.disabled = false;
    await reloadAll();
  }
};

$('drop').onclick = () => $('file').click();
$('file').onchange = (e) => uploadFiles([...e.target.files]);
$('drop').addEventListener('dragover', e => { e.preventDefault(); $('drop').classList.add('over'); });
$('drop').addEventListener('dragleave', () => $('drop').classList.remove('over'));
$('drop').addEventListener('drop', e => {
  e.preventDefault(); $('drop').classList.remove('over');
  uploadFiles([...e.dataTransfer.files].filter(f => f.type.startsWith('image/')));
});

async function uploadFiles(files) {
  const el = $('msg-face');
  if (!files.length) return;
  let done = 0;
  for (const f of files) {
    if (f.size > 8 * 1024 * 1024) { flash(el, false, `${f.name} 超过 8MB，跳过`); continue; }
    const r = await fetch('/api/upload?name=' + encodeURIComponent(f.name), {
      method: 'POST', body: f,
    }).then(x => x.json());
    if (!r.ok) { flash(el, false, `${f.name} 上传失败：${r.error}`); continue; }
    // 自动建一条，标签先用文件名，用户再改
    const tag = f.name.replace(/\.[^.]+$/, '').slice(0, 12) || '新表情';
    await api('/api/faces', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ action: 'add', tag, file: r.file, when: '（请填写适用场合）', desc: '' })
    });
    done++;
  }
  flash(el, true, `已上传 ${done} 张，请给它们填上「适用场合」`);
  await refreshFaces();
}

async function refreshFaces() {
  await reloadAll();
}

window.editFace = async (tag) => {
  const f = FACES.find(x => x.tag === tag);
  if (!f) return;
  const newTag = prompt('标签（模型调用时写 [表情:标签]，简短好记）', f.tag);
  if (newTag === null) return;
  const who = prompt('图里是谁（有人问「为什么发这个」时它要答得出；认不出就留空）', f.who || '');
  if (who === null) return;
  const when = prompt('适用场合（必填！不填它不会用这张）\n写得越具体，它用得越准', f.when || '');
  if (when === null) return;
  const r = await api('/api/faces', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({
      action: 'update', oldTag: tag, tag: newTag.trim(), file: f.file,
      who: who.trim(), when: when.trim(), desc: f.desc,
    })
  });
  if (r.ok) await reloadAll();
  else flash($('msg-face'), false, r.error);
};

window.delFace = async (tag) => {
  if (!confirm(`删除表情「${tag}」？图片文件也会被删掉。`)) return;
  const r = await api('/api/faces', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ action: 'delete', tag })
  });
  if (r.ok) await reloadAll();
};

// ── 知识库 ──

/* ⚠️ 2026-09-23「轻整理 / 重做」新增的纯前端工具（**都不碰后端**）—— */

let KFILES = [];      // 后端给的整份列表（含 desc/size/from/readonly）
let LEARNED_TOPICS = [];

/** 群资料库 / 动画库 / 敏感词 / 共用库（人设包在知识页已被排除）—— 分组按前缀认，不用猜 */
function kGroupOf(f) {
  if (f.name.startsWith('groups/')) return '群资料库';
  // ⚠️ 2026-09-28：观察记忆独立成组。它**不是**学习档案 ——
  //    所以 `isLearnedFile()` 不该把它算进去（那会要求它带 `<!-- LEARNED:* -->` 标记，
  //    而它是个整块自动覆盖的观察区，压根没有那对标记）。这里单开一组，
  //    免得它在"群资料库"里跟学到的知识混成一堆。
  if (f.name.startsWith('observe/')) return '观察';
  if (f.name.startsWith('anime/')) return '动画库';
  if (f.name.startsWith('sensitive/')) return '敏感词';
  if (f.from === 'persona') return '人设包';
  return '共用库';
}
// ⚠️ 2026-10-23 按页面分组（用户要求）：
//   · 「知识文件」只管 **动画库 + 共用库**（她知道的资料）
//   · 「观察记录」管 **群资料库 + 观测**（记录群/人/跑团的）
//   · **敏感词从列表里去掉**（它不归这两处管）
//   注意：`kGroupOf()` 还能返回「敏感词」「人设包」，但这两个组不在任何页面的白名单里，
//   于是自然不出现 —— 要恢复就把名字加回对应数组即可。
const KGROUPS_FILES = ['动画库', '共用库'];
const KGROUPS_OBSERVE = ['群资料库', '观察'];
const KLIB_DESC = {
  '群资料库': '哪个群、群友是谁、发生过什么 —— 放错会出现「我记录了你」这种副作用',
  '观察': '她**自己暗中攒**的群友性格和大事（按群/按人分开）—— 整块自动覆盖，别手改',
  '动画库': '二次元作品 / 乐队 / 角色 —— 读哪几个由人设的 anime.works 决定',
  '敏感词': '哪些话是雷、怎么绕 —— 独立成库，全局注入，不按群或角色筛选',
  '共用库': '服务器资料、学习档案、节日表 —— 所有群共享的东西',
};
/** 常见文件的稳定说明：后端暂时没有 desc 时，也不要退回显示原始文件名。 */
const KFILE_LABEL = {
  'observe/': '★ 群观察（这个群自己暗中攒的：群友性格、群里的大事）· 只在这个群注入',
  'sensitive/sensitive-words.md': '敏感词：只认不接，不重复、不引申、不顺着说',
  'hzymtr-server.md': '服务器知识库：进服、排障、规则、存档',
  'global.md': '★ 全局学习档案：**主人**教的短知识（所有群+私聊都读，优先级最高）',
  'learned.md': '学习档案（已废弃：2026-09-27 分层为 global/groups/dm，这里是老布局遗留）',
  // 分层后的另两份：群友教的（只在那个群算数）、私聊里教的（只跟那个人私聊时算数）
  'groups': '这个群教我的（只在这个群算数）',
  'dm': '这个人私聊里教我的（只跟他私聊时算数）',
  'memes.md': '梗库：常用梗和回复素材',
  'owner.md': '主人信息：群主、服务器主人等共用事实',
  'relationship.md': '关系设定：角色与主人 / 群友的关系',
  'holidays.md': '节日表：节日日期与活动信息',
};
let KLIB_CUR = '';

/** `.example.md` 是给新机器的模板，**不是活知识** ⇒ 不进列表
 *  （`webui.js` 那边 `endsWith('.md')` 拦不住它，改这里最省事、不动后端） */
function kIsTemplate(f) { return /\.example\.md$/i.test(f.name); }

/** ⚠️ 2026-09-23 第四轮：**人设包的文件不进这个列表**（用户要求）。
 *  理由：人设的东西在人设页管（那边有「人设文档」卡，**`persona.md` 也在那儿**），
 *  这边只留「动画库」和「共用库」⇒ 两边职责清楚，也不会出现两份 persona.md 改错地方。
 *  ⚠️ 所以 `PJ_DOC_ONLY` 那轮加了 `persona.md` —— 两处必须同时改，否则 persona.md 会没入口。 */
function kIsPersonaPack(f) { return f.from === 'persona'; }

/** 文件名旁边那句短标签（代替原来 option 里那一大坨） */
function kShortTag(f) {
  if (f.readonly) return '只读';
  if (f.from === 'persona') return '人设';
  if (f.name.startsWith('groups/')) return '分群';
  if (f.name.startsWith('anime/')) return '动画';
  if (f.name.startsWith('sensitive/')) return '敏感';
  return '';
}

function kFmtSize(n) {
  n = Number(n) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + 'M';
  if (n >= 1024) return (n / 1024).toFixed(1) + 'K';
  return n + 'B';
}

/** 文件下拉的短说明文字：不显示 anime/xxx.md 这类原始文件名。 */
function kFileLabel(f) {
  const group = kGroupOf(f);
  const desc = String(f.desc || '')
    .replace(/[`*_]/g, '')
    .replace(/📌/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const fixed = KFILE_LABEL[f.name] || '';
  let label = fixed || desc.split(/\s+——\s+|\s*⚠️\s*/)[0].trim();
  if (!label || label === group) label = `${group}资料`;
  return label.length > 48 ? `${label.slice(0, 45)}…` : label;
}

/** 动态填两个通栏大卡片下拉（保留 kListFilter 这个启动入口名）。
 *  ⚠️ 2026-09-25：原来这里填的是两个原生 `<select>`，现在改成
 *     「弹层列表（.klib / .kfcard）+ 大卡片上的当前值（.kpicker-value）」。
 *  ⚠️ 页面和列表里**只出现 kFileLabel() 说明文字**，绝不出现 anime/xxx.md 原始文件名。 */
function kListFilter() {
  const libMenu = $('k-lib-menu');
  const fileMenu = $('k-file-menu');
  const hint = $('k-libhint');
  if (!libMenu || !fileMenu) return;
  const cur = $('k-file').value;
  const groups = KGROUPS_FILES.filter((g) => KFILES.some((f) => kGroupOf(f) === g));
  if (!KLIB_CUR || !groups.includes(KLIB_CUR)) KLIB_CUR = groups[0] || '';
  // 「新建动画库」只在**动画库**这一组里出现；切到敏感词/共用库/群资料库就收起来。
  $('k-anime-new')?.classList.toggle('hidden', KLIB_CUR !== '动画库');
  libMenu.innerHTML = groups
    .map((g) => {
      const n = KFILES.filter((f) => kGroupOf(f) === g).length;
      const on = g === KLIB_CUR;
      return `<button type="button" role="option" aria-selected="${on}" class="klib${on ? ' on' : ''}"`
        + ` onclick="kPickLib('${esc(g).replace(/'/g, '&#39;')}')">`
        + `<span class="klt">${esc(g)}<span class="tag">${n} 个</span></span>`
        + `<span class="kln">${esc(KLIB_DESC[g] || '')}</span></button>`;
    })
    .join('') || '<span class="empty">还没有知识文件</span>';

  const items = KFILES.filter((f) => kGroupOf(f) === KLIB_CUR);
  fileMenu.innerHTML = items
    .map((f) => {
      const tag = kShortTag(f);
      const on = f.name === cur;
      return `<button type="button" role="option" aria-selected="${on}" class="kfcard${on ? ' on' : ''}"`
        + ` onclick="kPickFile('${esc(f.name).replace(/'/g, '&#39;')}')">`
        + `<span class="fn2"><span class="fnl">${esc(kFileLabel(f))}</span>`
        + (tag ? `<span class="tag">${esc(tag)}</span>` : '')
        + `</span><span class="fsz">${kFmtSize(f.size)}${f.readonly ? ' · 只读' : ''}</span></button>`;
    })
    .join('') || '<span class="empty">这个库里还没有文件</span>';

  // 大卡片上只写「当前选中项」；没有可用项时退回灰色占位文字。
  const curLib = $('k-lib-value');
  if (curLib) {
    curLib.textContent = KLIB_CUR || '（没有可用的知识库）';
    curLib.classList.toggle('is-empty', !KLIB_CUR);
  }
  const curFile = $('k-file-value');
  if (curFile) {
    const sel = items.find((f) => f.name === cur);
    curFile.textContent = sel ? kFileLabel(sel) : '（这个库里还没有文件）';
    curFile.classList.toggle('is-empty', !sel);
  }
  if (hint) hint.textContent = KLIB_CUR ? `${KLIB_CUR}：${KLIB_DESC[KLIB_CUR] || ''}` : '';
}

/** 通栏大卡片：点一下展开/收起；两个永远只开一个（另一个自动收起）。 */
function kDropToggle(which, prefix = 'k') {
  const id = which === 'lib' ? 'lib' : 'file';
  const btn = $(prefix + '-' + id + '-btn');
  const menu = $(prefix + '-' + id + '-menu');
  const wasOpen = btn && btn.getAttribute('aria-expanded') === 'true';
  kDropCloseAll();
  if (wasOpen || !btn || !menu) return;
  // 空列表（还没有知识文件）就别弹一个空壳出来。
  if (!menu.querySelector('button')) return;
  btn.setAttribute('aria-expanded', 'true');
  menu.classList.remove('hidden');
}

/** 两个下拉一起收起（点面板外、按 Esc、选中某一项后都走这里）。 */
function kDropCloseAll() {
  // ⚠️ 2026-10-23：知识文件（`k-`）和观察总结（`o-`）各有一套大卡片下拉，一起收起
  ['k', 'o'].forEach((prefix) => {
    ['lib', 'file'].forEach((id) => {
      const btn = $(prefix + '-' + id + '-btn');
      const menu = $(prefix + '-' + id + '-menu');
      if (btn) btn.setAttribute('aria-expanded', 'false');
      if (menu) menu.classList.add('hidden');
    });
  });
}

/** 点面板外 / 按 Esc 收起（document 上只绑一次，页面里所有这类下拉共用）。
 *  ⚠️ 命中 `.kpicker` 内部就放行 —— 按钮和列表项各自有 onclick，别在这里抢。 */
document.addEventListener('click', (e) => {
  if (e.target && e.target.closest && e.target.closest('.kpicker')) return;
  kDropCloseAll();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') kDropCloseAll();
});

/** 切库：自动选该库第一个文件，并按预览模式打开
 *  （两行文字必须一致 —— 不能"库=动画库、文件=群资料"）。 */
function kPickLib(group) {
  if (!KFILES.some((f) => kGroupOf(f) === group)) return;
  KLIB_CUR = group;
  const first = KFILES.find((f) => kGroupOf(f) === group);
  if (first) $('k-file').value = first.name;
  kListFilter();
  kDropCloseAll();
  kMode('prev');
  if (first) loadKnowledge();
}

/** 切文件：切库 + 选中 + 回预览，再读取新内容。 */
function kPickFile(name) {
  const f = KFILES.find((x) => x.name === name);
  if (!f) return;
  KLIB_CUR = kGroupOf(f);
  $('k-file').value = name;
  kListFilter();
  kDropCloseAll();
  kMode('prev');
  loadKnowledge();
}

/** desc 里的 Markdown 标记渲染成真的样式（`**粗体**` / `` `等宽` ``）
 *  ⚠️ 先 esc 再替换 ⇒ 说明文字里的尖括号不会变成 HTML。 */
function kDescHtml(desc) {
  let t = esc(String(desc || ''));
  t = t.replace(/`([^`]+)`/g, '<code>$1</code>');
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
  return t;
}

/** 右侧信息区：只显示标签和说明，不重复显示原始文件名。 */
function kRenderInfo(meta) {
  const tags = [];
  if (meta) {
    tags.push('<span class="tag accent">' + esc(kGroupOf(meta)) + '</span>');
    if (meta.from === 'persona') tags.push('<span class="tag">换人设会一起换</span>');
    if (meta.readonly) tags.push('<span class="tag warn">只读</span>');
    if (meta.groupId) tags.push('<span class="tag">只给群 ' + esc(meta.groupId) + ' 用</span>');
    tags.push('<span class="tag">' + esc(kFmtSize(meta.size)) + '</span>');
  }
  $('k-tags').innerHTML = tags.join('');
  $('k-desc').innerHTML = kDescHtml(meta ? meta.desc : '');
}

/** 「它学到的」搜索过滤：只在浏览器里筛，服务端和 learned.md 一个字没动。 */
function learnedFilter() {
  const box = $('learned-list');
  if (!box) return;
  const q = (($('learned-q') || {}).value || '').trim().toLowerCase();
  if (!LEARNED_TOPICS.length) {
    box.innerHTML = '<span class="empty">还没有学到额外的东西</span>';
    return;
  }
  const hit = q ? LEARNED_TOPICS.filter((t) => String(t).toLowerCase().includes(q)) : LEARNED_TOPICS;
  box.innerHTML = hit.length
    ? hit.map((t, i) => (i + 1) + '. ' + esc(t)).join('<br>')
    : '<span class="empty">没有匹配「' + esc(q) + '」的条目</span>';
}

/** 新建人设的 id 格式提示：**只提示、不拦提交、不改后端校验**。 */
function personaIdCheck() {
  const el = $('p-new-id-note');
  if (!el) return;
  const v = (($('p-new-id') || {}).value || '').trim();
  el.classList.remove('on');
  if (!v) return;
  const ok = /^[a-z0-9_-]+$/.test(v);
  el.textContent = ok ? '✅「' + v + '」可以用' : '⚠️ 只能用小写字母、数字、横线（现在是「' + v + '」）';
  el.classList.add('on');
}

/* ── 人设页 P1–P3（2026-09-23）—— 纯前端交互，都不动 id 和后端 ── */

/** P1：状态卡里的「切换人设」—— 就地展开/收起那一小块（不弹窗、不新增组件）。 */
function personaToggleSwitch() {
  const box = $('p-switch-box');
  const btn = $('p-switch-btn');
  if (!box) return;
  const open = box.classList.toggle('hidden') === false;
  if (btn) btn.textContent = open ? '收起' : '切换人设';
  if (open) personaPickChange();
}

/** P2：`?` 小圆点 —— 点一下就把说明就地展开在它下面，再点收起。
 *  ⚠️ **故意不做纯 hover tooltip**：鼠标移开就没了、装不下加粗/换行、触屏根本触发不了。
 *     键盘也管用（`tabindex=0` + Enter/Space）。 */
function qToggle(el) {
  if (!el) return;
  // ⚠️ 展开块要插在**整个 label 外面** —— `.fld>label` 是 flex（为了塞标题+code key+?），
  //    插进去会被当 flex item 挤扁。
  const host = el.closest('label') || el.parentNode;
  let box = host.nextElementSibling;
  if (!box || !box.classList.contains('qbox')) {
    box = document.createElement('div');
    box.className = 'qbox';
    host.parentNode.insertBefore(box, host.nextSibling);
    box.textContent = el.getAttribute('data-q') || '';
  }
  const open = box.hidden === false;
  box.hidden = open;
  el.classList.toggle('open', !open);
}
document.addEventListener('click', (e) => {
  const q = e.target.closest ? e.target.closest('.q[data-q]') : null;
  if (q) { qToggle(q); return; }
  // 点空白处把展开的 `?` 收起来（同一时刻只留一个）
  if (!e.target.closest || !e.target.closest('.qbox')) {
    document.querySelectorAll('.qbox').forEach((b) => { b.hidden = true; });
    document.querySelectorAll('.q.open').forEach((b) => b.classList.remove('open'));
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const q = e.target.closest ? e.target.closest('.q[data-q]') : null;
  if (q) { e.preventDefault(); qToggle(q); }
});

/** P3：「新建人设」顶上的 AI / 手动分段。
 * 两种模式共用三个基础字段；切换只改变主按钮和手动模板选择区，不清空已填内容。 */
function personaNewMode(m) {
  const manual = m === 'manual';
  const ai = $('p-mode-ai'), mm = $('p-mode-manual');
  if (ai) ai.classList.toggle('on', !manual);
  if (mm) mm.classList.toggle('on', manual);
  const template = $('p-template-row');
  if (template) template.classList.toggle('hidden', !manual);
  const primary = $('p-new-primary');
  if (primary) {
    primary.textContent = manual ? personaTemplateButtonText() : 'AI 联网生成起草';
    primary.title = manual ? '按当前关联模板创建新人设包' : '联网搜集资料并生成可预览的人设草稿';
  }
  const hint = $('p-mode-hint');
  if (hint) {
    hint.textContent = manual
      ? '不联网：从关联模板创建，再逐项编辑'
      : '联网搜资料 → 按模板逐字段填满 → 给你过一眼再落盘';
  }
}

/** 同一个主按钮按当前模式分派：AI 起草 / 手动创建。 */
function personaNewPrimary() {
  return $('p-mode-manual')?.classList.contains('on') ? personaCreate() : personaDraftStart();
}

function personaTemplateButtonText() {
  return ($('p-new-from')?.value || '_template') === '_template' ? '创建标准模板' : '创建';
}

function personaTemplateChange() {
  if (!$('p-mode-manual')?.classList.contains('on')) return;
  $('p-new-primary').textContent = personaTemplateButtonText();
}

/* ── 动画库：这里只列现成的库；新建统一在知识库页 ──
   下拉只负责把已有库加入 hidden input，收集函数照旧，`pjList` 会去重/trim。 */
function animeLibAddExisting() {
  const sel = $('pf-anime-libpick');
  const hid = $('pf-anime-works');
  if (!sel || !hid || !sel.value) return;
  hid.value = pjList(hid.value + '、' + sel.value).join('、');
  sel.value = '';
  tagsSync('pf-anime-works');
}
document.addEventListener('change', (e) => {
  if (e.target && e.target.id === 'pf-anime-libpick') animeLibAddExisting();
});

/* ── P5：Tag Input（2026-09-23）──
   ⚠️ **值永远存在旁边那个 hidden input 里**（`、`-分隔），标签只是皮。
      所以 `personaCollectIdentity()` 里 `pjList($('pf-'+k).value)` 那几行**一个字都没改**
      —— 少一个「保存后格式变了/值丢了」的风险类别。
   ⚠️ 切包（`personaOpen`）会重渲染这些字段，所以同步函数要能反复调。 */

/** 把 hidden input 里的 `a、b、c` 画成一排标签（+ 末尾一个输入框） */
function tagsSync(inputId) {
  const box = $('tags-' + inputId);
  const hid = $(inputId);
  if (!box || !hid) return;
  const add = box.querySelector('.tagadd');
  const keep = add ? add.outerHTML : '<input class="tagadd" placeholder="输入后回车">';
  const list = pjList(hid.value);
  const items = list
    .map((t) => '<span class="tagitem"><span>' + escHtml(t) + '</span>' +
      '<button type="button" data-del="' + escAttr(t) + '" title="删掉这个">×</button></span>')
    .join('');
  // 四个称呼字段使用同一种两行结构：输入框在第一行，标签/示例在第二行。
  // 示例只是视觉提示，不进入 hidden input；用户一输入真实标签就自动消失。
  const example = !list.length && box.dataset.example
    ? '<span class="tagitem example" aria-label="示例">' + escHtml(box.dataset.example) + '</span>'
    : '';
  const content = items || example;
  box.innerHTML = box.classList.contains('tags-stacked')
    ? keep + '<div class="taglist">' + content + '</div>'
    : items + keep;
  hid.value = list.join('、');
}

/** 标签区的事件代理（只绑一次，因为字段是 innerHTML 重渲染出来的） */
document.addEventListener('keydown', (e) => {
  const inp = e.target.closest ? e.target.closest('.tags .tagadd') : null;
  if (!inp) return;
  const box = inp.closest('.tags');
  const hid = $(box.getAttribute('data-for'));
  if (!hid) return;
  // 逗号（含中文逗号）也收 —— 用户很可能不打回车直接打逗号
  if (e.key === 'Enter' || e.key === ',' || e.key === '，') {
    e.preventDefault();
    const v = inp.value.trim();
    if (v) { hid.value = pjList(hid.value + '、' + v).join('、'); inp.value = ''; tagsSync(box.getAttribute('data-for')); }
    return;
  }
  // 空着按退格 = 删最后一个
  if (e.key === 'Backspace' && !inp.value) {
    const list = pjList(hid.value);
    if (list.length) { list.pop(); hid.value = list.join('、'); tagsSync(box.getAttribute('data-for')); }
  }
});
document.addEventListener('click', (e) => {
  const del = e.target.closest ? e.target.closest('.tags .tagitem button[data-del]') : null;
  if (!del) return;
  const box = del.closest('.tags');
  const hid = $(box.getAttribute('data-for'));
  if (!hid) return;
  const t = del.getAttribute('data-del');
  hid.value = pjList(hid.value).filter((x) => x !== t).join('、');
  tagsSync(box.getAttribute('data-for'));
});
// 输入过程中就隐藏空值示例：一旦开始输入，当前字段就不再是“未填”。
// 不在这里重建 innerHTML，避免输入框失焦、光标跳回开头。
document.addEventListener('input', (e) => {
  const inp = e.target.closest ? e.target.closest('.tags .tagadd') : null;
  if (!inp) return;
  const box = inp.closest('.tags');
  const hid = $(box.getAttribute('data-for'));
  if (!hid) return;
  const example = box.querySelector('.tagitem.example');
  if (example) example.hidden = !!inp.value.trim() || pjList(hid.value).length > 0;
});
// 失焦时把还留在输入框里的那半截也收成标签（`pjList` 会 trim 掉空格）
document.addEventListener('focusout', (e) => {
  const inp = e.target.closest ? e.target.closest('.tags .tagadd') : null;
  if (!inp) return;
  const v = inp.value.trim();
  if (!v) return;
  const box = inp.closest('.tags');
  const hid = $(box.getAttribute('data-for'));
  if (!hid) return;
  hid.value = pjList(hid.value + '、' + v).join('、');
  inp.value = '';
  tagsSync(box.getAttribute('data-for'));
});

/** 行号槽：跟着 textarea 的行数和滚动走 */
function kGutter() {
  const ta = $('k-content');
  const g = $('k-gutter');
  if (!ta || !g) return;
  const lines = (ta.value.match(/\n/g) || []).length + 1;
  if (g.dataset.n !== String(lines)) {
    g.dataset.n = String(lines);
    g.textContent = Array.from({ length: lines }, (_, i) => i + 1).join('\n');
  }
  g.scrollTop = ta.scrollTop;
}

/** 字数统计：只做显示，**不拦保存**（真要限长由后端说了算） */
function kCountUpdate() {
  const el = $('k-count');
  if (!el) return;
  el.textContent = '当前 ' + (($('k-content').value || '').length) + ' 字';
}

$('k-content').addEventListener('input', () => { kCountUpdate(); kGutter(); kValidate(); });
$('k-content').addEventListener('scroll', () => { $('k-gutter').scrollTop = $('k-content').scrollTop; });

/**
 * 这个文件是不是一份「学习档案」（★ B 方案：四种都算）。
 *
 * ⚠️ 光看名字不够 —— 所以 `kValidate()` 另外还看**内容里有没有 LEARNED 标记**
 *    （跟后端 `webui.js` 的保存校验同一个判据，两边必须一致，否则前端放行、后端拒绝）。
 */
function isLearnedFile(name) {
  const n = String(name || '');
  return n === 'global.md' || n === 'learned.md' || /^(groups|dm)\/\d+\.md$/.test(n);
}

/** 学习档案格式校验（**只提示，不拦保存** —— 后端 `learnedValidate` 才是最终裁决）。
 *  ⚠️ 规则和 `src/learned.js` 的 `validateFile` 对齐：缺 BEGIN / 缺 END / 顺序反了 /
 *     有内容但没 `## 主题` / 某条下面是空的。
 *  ⚠️ 判据 = 「是全局层那两份」**或**「内容里带 LEARNED 标记」——
 *     按文件名硬列会漏掉 `groups/` `dm/` 那两份；而只看内容的话，
 *     全局层被人**把标记整段删光**就反而不校验了（那种情况后端会拒，前端得跟上）。 */
const K_BEGIN = '<!-- LEARNED:BEGIN -->';
const K_END = '<!-- LEARNED:END -->';
function kValidate() {
  const el = $('k-valid');
  if (!el) return;
  const name = $('k-file').value;
  const t = $('k-content').value || '';
  // ⚠️ 写成 `[...].includes()` 而不是 `name === 'learned.md'`：
  //    `test/learned-edit.js`【7】会搜代码区里写死的 `name === 'learned.md'`（防只读回潮），语义相同、不撞红线。
  const isGlobal = ['global.md', 'learned.md'].includes(name);
  if (!isGlobal && !t.includes(K_BEGIN) && !t.includes(K_END)) {
    el.classList.remove('on');
    return;
  }
  const i = t.indexOf(K_BEGIN), j = t.indexOf(K_END);
  let bad = '';
  if (i === -1) bad = '缺少 ' + K_BEGIN + ' 这一行（代码靠它定位条目，删了 learn()/forget() 会静默失效）';
  else if (j === -1) bad = '缺少 ' + K_END + ' 这一行';
  else if (j < i) bad = K_END + ' 跑到 ' + K_BEGIN + ' 前面了';
  else {
    const block = t.slice(i + K_BEGIN.length, j);
    const ms = [...block.matchAll(/^##\s+(.+?)\s*$/gm)];
    if (!ms.length && block.replace(/\s/g, '')) {
      bad = 'BEGIN/END 之间只有文字，但没一条 `## 主题` —— 代码解析不出条目（等于内容丢了）';
    } else {
      for (let k = 0; k < ms.length && !bad; k++) {
        const end = k + 1 < ms.length ? ms[k + 1].index : block.length;
        if (!block.slice(ms[k].index + ms[k][0].length, end).trim()) {
          bad = '条目「' + ms[k][1].trim() + '」下面是空的';
        }
      }
    }
  }
  el.classList.add('on');
  if (bad) { el.className = 'kvalid on bad'; el.textContent = '❌ ' + bad; }
  else {
    const n = (t.slice(i + K_BEGIN.length, j).match(/^##\s+/gm) || []).length;
    el.className = 'kvalid on good'; el.textContent = '✅ 格式合格（' + n + ' 条知识）';
  }
}

/** 编辑 / 预览 切换 */
function kMode(m) {
  const isEdit = m !== 'prev';
  $('k-mode-edit').classList.toggle('on', isEdit);
  $('k-mode-prev').classList.toggle('on', !isEdit);
  $('k-editwrap').classList.toggle('hidden', !isEdit);
  $('k-preview').classList.toggle('hidden', isEdit);
  if (isEdit) kGutter();
  else $('k-preview').innerHTML = kMarkdown($('k-content').value || '');
}

/** 重新读取：放弃当前未保存的改动，从磁盘再拉一次。
 *  ⚠️ 这不是"回滚到上次保存" —— 那需要读 logs/backup/，**得后端加接口**，本轮没做。 */
function knowledgeReload() {
  loadKnowledge();
  flash($('msg-k'), true, '已重新读取');
}

/** 极简 Markdown 渲染（**先整体 esc**，所以原文件里的 HTML 不会执行）
 *  ⚠️ 只做「看得懂」那一层：标题/粗体/斜体/行内码/代码块/列表/引用/分隔线/表格/链接。 */
function kMarkdown(src) {
  const blocks = [];
  let t = esc(String(src));
  t = t.replace(/```([\s\S]*?)```/g, (_, c) => { blocks.push(c); return '\u0001B' + (blocks.length - 1) + '\u0001'; });
  const inline = (x) => x
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<i>$2</i>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
  const out = [];
  let list = null;
  const closeList = () => { if (list) { out.push('</' + list + '>'); list = null; } };
  for (const raw of t.split(/\r?\n/)) {
    const line = raw.trimEnd();
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { closeList(); out.push('<h' + h[1].length + '>' + inline(h[2]) + '</h' + h[1].length + '>'); continue; }
    const fence = line.trim().match(/^\u0001B(\d+)\u0001$/);
    if (fence) { closeList(); out.push('<pre><code>' + blocks[Number(fence[1])] + '</code></pre>'); continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { closeList(); out.push('<hr>'); continue; }
    if (/^\s*&gt;\s?/.test(line)) { closeList(); out.push('<blockquote>' + inline(line.replace(/^\s*&gt;\s?/, '')) + '</blockquote>'); continue; }
    const ul = line.match(/^\s*[-*+]\s+(.*)$/);
    const ol = line.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      const want = ul ? 'ul' : 'ol';
      if (list !== want) { closeList(); out.push('<' + want + '>'); list = want; }
      out.push('<li>' + inline((ul || ol)[1]) + '</li>'); continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.split('|').slice(1, -1).map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue;   // 分隔行不渲染
      closeList();
      out.push('<tr>' + cells.map((c) => '<td>' + inline(c) + '</td>').join('') + '</tr>'); continue;
    }
    if (!line.trim()) { closeList(); continue; }
    closeList();
    out.push('<p>' + inline(line) + '</p>');
  }
  closeList();
  // 连续的 <tr> 收成 <table>
  return out.join('').replace(/(<tr>[\s\S]*?<\/tr>)+/g, (m) => '<table>' + m + '</table>');
}

/** 动态填知识文件列表（后端返回的列表，加了新文件不用改这里） */
async function loadKnowledgeList(keep) {
  const r = await api('/api/knowledge/list');
  // ⚠️ 2026-09-23：把 `.example.md` 模板剔掉 —— 它们是给新机器的样张，
  //    改它们"保存成功但没生效"，正是这套代码反复警告的坑。
  // ⚠️ 同理剔掉**人设包的文件**（用户 2026-09-23 要求）：那边在人设页的「人设文档」卡里管，
  //    这边只留「动画库」和「共用库」。
  KFILES = (r.files ?? []).filter((f) => !kIsTemplate(f) && !kIsPersonaPack(f));
  // ⚠️ 旧页面默认选 `persona.md`，但这一页后来明确把整包人设文件移到了「人设」页。
  //    如果还死盯那个名字，首次打开就会 #k-file 为空，编辑器与预览一起是空的 ——
  //    用户看到的现象就是「预览按钮点了没反应」。这里改成：保留仍然有效的当前选择，
  //    否则选过滤后的第一项；一个可用文件都没有时才清空。
  const current = keep || $('k-file').value;
  const currentFile = KFILES.find((f) => f.name === current);
  if (currentFile) KLIB_CUR = kGroupOf(currentFile);
  if (!KLIB_CUR) KLIB_CUR = KGROUPS_FILES.find((g) => KFILES.some((f) => kGroupOf(f) === g)) || '';
  const want = currentFile ? current : (KFILES.find((f) => kGroupOf(f) === KLIB_CUR)?.name || '');
  $('k-file').value = want;
  kListFilter();
  return KFILES;
}

async function loadKnowledge() {
  const name = $('k-file').value;
  if (!name) return;
  // ⚠️ 2026-09-23：「它学到的」面板只在**选中学习档案**时出现 ——
  //    它本来就是学习档案的内容视图（条目解析自同一份文件），
  //    原来却是页面底部一张独立卡片，看着像另一件不相干的事。
  //    ⚠️ 2026-09-27（B 方案）：判据从 `name === 'learned.md'` 换成 `isLearnedFile()`
  //       —— 现在有四份（global / 老 learned / groups/ / dm/），写死一个名字会全漏。
  kLearnedPane(name);
  const r = await api('/api/knowledge?name=' + encodeURIComponent(name));
  const list = await api('/api/knowledge/list');
  const meta = (list.files ?? []).find((f) => f.name === name);
  kRenderInfo(meta);
  kListFilter();
  if (!r.ok) {
    const failed = '（读取失败：' + r.error + '）';
    $('k-content').value = failed;
    if ($('k-mode-prev').classList.contains('on')) $('k-preview').textContent = failed;
    kGutter();
    kValidate();
    return;
  }
  $('k-content').value = r.content;
  // ⚠️ 只读与否**完全由服务端说了算**（`meta.readonly`）。
  //    原来这里还写死了一句 `|| name === 'learned.md'` ——
  //    于是服务端把 `learned.md` 放开之后，**界面照样锁着**，
  //    改了半天没效果。这类"两边各写一份判断"的地方最容易漏。
  const readOnly = meta?.readonly === true;
  $('k-content').readOnly = readOnly;
  $('k-save').disabled = readOnly;
  $('k-save').textContent = readOnly ? '只读' : '保存';
  kCountUpdate();
  kGutter();
  kValidate();
  if ($('k-mode-prev').classList.contains('on')) $('k-preview').innerHTML = kMarkdown(r.content);
}

/** 「它学到的」面板的显隐：只有选中**学习档案**时才显示（它就是那类文件的内容视图）。 */
function kLearnedPane(name) {
  const w = $('k-learnwrap');
  if (w) w.classList.toggle('hidden', !isLearnedFile(name));
}

/** 未保存标记：⚠️ 改了内容但没存时，在保存栏上亮一个点。
 *  ⚠️ 只是提醒，**不拦你切文件** —— 切了会丢（真要保险得做草稿缓存，另记 TODO）。 */
function kDirty(on) {
  const d = $('k-dirty');
  if (d) d.classList.toggle('on', !!on);
  const s = $('k-save');
  if (s && !s.disabled) s.textContent = on ? '保存 ●' : '保存';
}

async function saveKnowledge() {
  const el = $('msg-k');
  const r = await api('/api/knowledge', {
    method: 'POST', headers: {'Content-Type':'application/json'},
    body: JSON.stringify({ name: $('k-file').value, content: $('k-content').value })
  });
  flash(el, r.ok, r.ok ? '已保存并生效' : ('保存失败：' + r.error));
  // ⚠️ 保存后重拉一次：拿到服务端算出来的 size / 只读状态，顺带刷新列表上的字数
  if (r.ok) loadKnowledge();
}

/* ── 知识库页：新建动画库（AI 起草 → 预览 → 保存） ── */
let KANIME_DRAFT = null;
let KANIME_MODE = 'ai';

function kAnimeClearMessages() {
  for (const id of ['k-anime-msg', 'k-anime-msg2', 'k-anime-mainmsg']) {
    const el = $(id);
    if (el) { el.className = 'msg'; el.textContent = ''; }
  }
}

function kAnimeMode(m) {
  const manual = m === 'manual';
  KANIME_MODE = manual ? 'manual' : 'ai';
  const ai = $('k-anime-mode-ai');
  const mm = $('k-anime-mode-manual');
  if (ai) ai.classList.toggle('on', !manual);
  if (mm) mm.classList.toggle('on', manual);
  const button = $('k-anime-draft-btn');
  if (button) button.textContent = manual ? '生成手动模板' : 'AI 起草';
  const hint = $('k-anime-mode-hint');
  if (hint) hint.textContent = manual
    ? '不联网：生成可编辑的库骨架，再手动补充'
    : '联网搜资料 → 生成可预览的库正文';
  const label = $('k-anime-preview-label');
  if (label) label.textContent = manual
    ? '手动模板（可以直接修改，再保存）'
    : '起草结果（可以直接修改，再保存）';
  const regenerate = $('k-anime-regenerate');
  if (regenerate) regenerate.textContent = manual ? '重新生成模板' : '重新起草';
}

function kAnimeNewCancel() {
  KANIME_DRAFT = null;
  $('k-anime-newbox')?.classList.add('hidden');
  $('k-anime-previewwrap')?.classList.add('hidden');
  if ($('k-anime-preview')) $('k-anime-preview').value = '';
  if ($('k-anime-sources')) $('k-anime-sources').textContent = '';
  const save = $('k-anime-save');
  if (save) save.disabled = true;
  kAnimeClearMessages();
  kAnimeMode('ai');
}

function kAnimeNewToggle() {
  const form = $('k-anime-newbox');
  if (!form) return;
  if (!form.classList.contains('hidden')) return kAnimeNewCancel();
  kAnimeNewCancel();
  form.classList.remove('hidden');
}

function kAnimeInputs() {
  const name = ($('k-anime-name')?.value || '').trim();
  const work = ($('k-anime-work')?.value || '').trim();
  const characters = ($('k-anime-characters')?.value || '').trim();
  const msg = $('k-anime-previewwrap')?.classList.contains('hidden') ? $('k-anime-msg') : $('k-anime-msg2');
  if (!name) {
    flash(msg, false, '库名必须填（例：bangdream）');
    return null;
  }
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(name) || name.includes('..')) {
    flash(msg, false, '库名只能是小写字母、数字、点、横线或下划线，且必须字母数字开头');
    return null;
  }
  if (KFILES.some((f) => f.name === `anime/${name}.md`)) {
    flash(msg, false, `动画库「${name}」已经存在了，直接打开它修改即可`);
    return null;
  }
  if (!work) {
    flash(msg, false, '作品名 / 关键词必须填（例：BanG Dream!）');
    return null;
  }
  return { name, work, characters };
}

async function kAnimeDraft() {
  const manual = KANIME_MODE === 'manual';
  const values = kAnimeInputs();
  if (!values) return;
  // 重新生成失败时不能继续保存上一份旧草稿，否则用户会误以为这次结果已经替换成功。
  KANIME_DRAFT = null;
  const button = $('k-anime-draft-btn');
  const save = $('k-anime-save');
  if (button) button.disabled = true;
  if (save) save.disabled = true;
  const progressMsg = $('k-anime-previewwrap')?.classList.contains('hidden') ? $('k-anime-msg') : $('k-anime-msg2');
  flash(progressMsg, true, manual ? '正在生成手动模板…' : '联网搜资料 + 起草中…（30~60 秒，别关页面）');
  try {
    const r = await api('/api/knowledge/draft-anime', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...values, mode: manual ? 'manual' : 'ai' }),
    });
    if (!r || !r.ok) {
      flash(progressMsg, false, (r && r.error) || (manual ? '手动模板生成失败' : '动画库起草失败'));
      return;
    }
    KANIME_DRAFT = { ...r, mode: manual ? 'manual' : 'ai', work: values.work, characters: values.characters };
    if (save) save.disabled = false;
    $('k-anime-preview').value = r.content || '';
    $('k-anime-sources').textContent = manual
      ? '已生成可编辑的库骨架；主要角色可以留空，保存前直接补正文即可。'
      : (r.sources?.length ? `参考了 ${r.sources.length} 条资料。` : '这次没有搜到资料，内容主要来自模型知识。')
        + (r.notes?.length ? ` 提醒：${r.notes.join('；')}` : '');
    $('k-anime-newbox').classList.add('hidden');
    $('k-anime-previewwrap').classList.remove('hidden');
    flash($('k-anime-msg2'), true, manual ? '手动模板已生成，可以直接修改后保存' : '起草完成，可以直接修改后保存');
  } catch (e) {
    flash(progressMsg, false, manual ? '手动模板生成出错：' + e.message : '动画库起草出错：' + e.message);
  } finally {
    if (button) button.disabled = false;
  }
}

async function kAnimeRegenerate() {
  await kAnimeDraft();
}

async function kAnimeSave() {
  if (!KANIME_DRAFT) {
    flash($('k-anime-msg2'), false, `先点「${KANIME_MODE === 'manual' ? '生成手动模板' : 'AI 起草'}」拿到正文`);
    return;
  }
  if (!KANIME_DRAFT.work) {
    flash($('k-anime-msg2'), false, '作品名 / 关键词必须填');
    return;
  }
  const content = ($('k-anime-preview').value || '').trim();
  if (!content) {
    flash($('k-anime-msg2'), false, '正文是空的，先补一点内容再保存');
    return;
  }
  const name = KANIME_DRAFT.name;
  const save = $('k-anime-save');
  if (save) save.disabled = true;
  try {
    const r = await api('/api/knowledge/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'anime', name, content }),
    });
    if (!r || !r.ok) {
      flash($('k-anime-msg2'), false, (r && r.error) || '保存动画库失败');
      return;
    }
    const file = `anime/${name}.md`;
    await loadKnowledgeList(file);
    KLIB_CUR = '动画库';
    $('k-file').value = file;
    kListFilter();
    await loadKnowledge();
    $('k-anime-name').value = '';
    $('k-anime-work').value = '';
    $('k-anime-characters').value = '';
    kAnimeNewCancel();
    flash($('k-anime-mainmsg'), true, `已创建「${name}」；要让角色读它，请到「人设 → 身份与话术」关联`);
  } catch (e) {
    flash($('k-anime-msg2'), false, '保存动画库出错：' + e.message);
  } finally {
    if (save) save.disabled = false;
  }
}

function kAnimeDrop() {
  kAnimeNewCancel();
}

// 启动：先拉知识文件列表，再读第一个
loadKnowledgeList().then(() => loadKnowledge());

// 启动
// ⚠️ 2026-10-07 多 QQ 号：**先问清"这个进程在控制哪个号"，再拉整页数据** ——
//    顺序反了的话，切过号的人一刷新会先看到"本进程那个号"的设置。
(async () => {
  await initAccounts();
  await renderAccounts();
  reloadAll();
})();
// ─────────────────────────────────────────────────────────────
// 人设页（2026-09-21 加：能直接切换机器人核心人设）
// ─────────────────────────────────────────────────────────────
//
// ⚠️ 后端那几条路由在 `webui.js` 的 `/api/persona*`；
//    文件层（读 / 写 / 校验 / 备份 / 新建 / 删除）在 `src/persona-admin.js`。
// ⚠️ **保存和切换都不重启机器人** —— 后端会热重载（用户 2026-09-21 定的）。

/** 界面上正在看的那个包 */
let PJ = { id: '', identity: {}, packs: [], current: '' };

/** 结构化字段 · 顶层字符串：[键, 标签, 说明] */
const PJ_STR = [
  ['name', '角色全名', '提示词里要用它（例：丰川祥子）'],
  ['selfName', '自称', '她自己提自己时用哪个词（例：Saki）'],
  ['displayName', '对外显示的身份', '例：客服 Saki'],
  ['shortName', '群里的昵称', '状态标题那种「捧场小祥」用它（例：小祥）'],
  ['narrativeName', '剧情里的第三人称名', '例：祥子'],
];
/** 结构化字段 · 数组（界面上按顿号/逗号分隔）
 *  第四项只是空值时的视觉示例，不会写入 identity。 */
const PJ_ARR = [
  ['selfNames', '判断「是不是在说她」要用的写法', '中英文都写上', '例：miku'],
  ['callNames', '群友怎么叫她算「点名叫她」', '这些名字一出现就必须回', '例：miku'],
  ['nicknames', '所有外号', '别人叫她任何一个外号，她都应该正常回应', '例：小祥'],
  ['matchNames', '判据用的名字原子', '允许单字和变体（「祥」能匹配「小祥」「祥子」）；留空＝自动从上面几个凑', '例：祥'],
];
/** 她怎么称呼别人（`address`）—— ⚠️ 2026-10-22 删掉 `ownerRule`（用户：「这个可以去掉」） */
const PJ_ADDR = [
  ['owner', '平时怎么叫主人', '例：<主人>'],
  ['ownerFormal', '正式场合怎么叫', '例：老板；没有这种场合就留空'],
];

// ⚠️ 2026-09-23 第四轮：知识页已经**不再列人设包的文件**（那边只留动画库+共用库），
//    所以 `persona.md`（人设正文，最重要的那个）挪到这里来 —— 它必须有个界面入口。
//    ⚠️ 这两处是**配套改动**：知识页排掉人设包 ⇔ 这里必须补上 persona.md，否则它就没入口了。
const PJ_DOC_ONLY = ['persona.md', 'cast.md', 'life-events.md', 'quest-ideas.md', 'persona-money.md', 'persona-media.md'];

/** HTML 转义：凡是要拼进 innerHTML 的值都得过一遍（`escAttr` 连引号一起挡） */
const escHtml = (s) => String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const escAttr = (s) =>
  escHtml(s)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/**
 * 把 hint 拆成「示例」和「真正的规则」两半（2026-10-06 从 `personaRenderFields` 里提到顶层）。
 *
 * ⚠️⚠️ **为什么必须提到顶层**：原来它是 `personaRenderFields()` 内部的局部 const。
 *   而 `renderDiceMode()`（骰娘模式那张卡）**也要用它** —— 局部变量在别的函数里
 *   根本不可见，于是那边一调就抛 `hintSplit is not defined`。
 *   ⚠️ 那个抛错被 `renderDiceMode` 自己的 `catch` 吞掉、只 `flash` 一行「出错：…」，
 *   **页面不炸、测试也不查 JS 运行期**，所以这个洞一直没被发现 ——
 *   表现就是「骰娘触发词那三个输入框**根本不出现**」（`dm-tagger` 一直是空的）。
 *   ⇒ 别把它再塞回某个函数里；要改就改这里。
 */
const hintSplit = (hint) => {
  const h = String(hint || '').trim();
  if (!h) return { ph: '', tip: '' };
  if (/^例[：:]/.test(h)) return { ph: h.replace(/^例[：:]\s*/, '例：'), tip: '' };
  return { ph: '', tip: h };
};

function pjShow(el, ok, text) {
  flash(el, ok, text);
}

/** 渲染一次人设页（进标签页时调） */
async function personaRefresh() {
  const r = await api('/api/persona/list');
  // ⚠️⚠️ **不要静默 return** —— 第一版就是 `if (!r.ok) return;`，
  //    结果后端 500（`personaId is not defined`）时整页**全空**，
  //    用户只看到"下拉是空的、字段也是空的"，完全不知道出了什么错（2026-09-21 真实踩到）。
  //    现在把错误**显示在页面上**。
  if (!r || !r.ok) {
    $('p-cur').innerHTML = `<div class="hint">⚠️ 读不到人设列表：${escHtml((r && r.error) || '接口没响应')}</div>`;
    $('p-cur-pill').textContent = '?';
    return;
  }
  PJ.packs = r.packs || [];
  PJ.current = r.current || '';
  $('p-cur-pill').textContent = PJ.current;
  const cur = PJ.packs.find((p) => p.id === PJ.current);
  // ⚠️ 2026-09-23 P1：状态卡 = 名字（大字）+ 几条紧凑标签。
  //    ⚠️ 头像走**现成接口** `/api/persona/avatar?id=<id>`（webui.js 里早就有），
  //       没有头像文件时那个接口返回 404 ⇒ onerror 回退到「取名字第一个字」的占位。
  $('p-cur-name').textContent = cur ? (cur.name || cur.displayName || cur.id) : '（没装好人设包）';
  $('p-cur').innerHTML = cur
    ? [
        ['id', cur.id, 'mono'],
        ['自称', cur.selfName || '—'],
        ['显示名', cur.displayName || '—'],
        // ⚠️ 2026-09-23 第四轮：删掉「文档 X 份 · XXX 字」那一项（用户说冗余）。
        //    想知道有多少文档，去「人设文档」卡的下拉里数更准。
      ]
        .map(([k, v, cls]) => `<span${cls ? ' class="' + cls + '"' : ''}><b>${k}</b>${String(v)}</span>`)
        .join('')
    : '';
  {
    // 头像：先按「有没有 avatar 文件」决定要不要 <img>，免得每次刷新都吃一个 404
    const ava = $('p-cur-ava');
    const initial = $('p-cur-initial');
    const showImg = !!(cur && cur.qq && cur.qq.avatar && cur.avatarReady);
    if (ava) {
      ava.querySelectorAll('img').forEach((n) => n.remove());
      if (showImg) {
        const im = document.createElement('img');
        im.alt = cur.name || cur.id;
        im.src = '/api/persona/avatar?id=' + encodeURIComponent(cur.id) + '&t=' + Date.now();
        im.onerror = () => { im.remove(); if (initial) { initial.hidden = false; initial.textContent = (cur.name || cur.id).slice(0, 1); } };
        ava.prepend(im);
        if (initial) initial.hidden = true;
      } else if (initial) {
        initial.hidden = false;
        initial.textContent = cur ? (cur.name || cur.id).slice(0, 1) : '?';
      }
    }
  }
  $('p-pick').innerHTML = PJ.packs
    .map(
      (p) =>
        `<option value="${p.id}"${p.id === PJ.current ? ' selected' : ''}>${p.id}` +
        `${p.name ? '　' + p.name : ''}${p.broken ? '　⚠️ ' + p.broken : ''}</option>`,
    )
    .join('');
  const oldTemplate = $('p-new-from').value || '_template';
  $('p-new-from').innerHTML =
    '<option value="_template">标准模板（空白骨架）</option>' +
    PJ.packs.map(
      (p) => `<option value="${escAttr(p.id)}">${escHtml(p.id + (p.name ? ' · ' + p.name : ''))}</option>`,
    ).join('');
  const templateOptions = [...$('p-new-from').options].map((o) => o.value);
  $('p-new-from').value = templateOptions.includes(oldTemplate) ? oldTemplate : '_template';

  // 动画库列表只给「身份与话术」的现成库下拉用；新建动画库统一在知识库页。
  PJ.animeLibs = r.animeLibs || [];
  personaTemplateChange();
  personaNewMode($('p-mode-manual').classList.contains('on') ? 'manual' : 'ai');
  personaPickChange();
  await personaOpen(PJ.current);
  qqProfileRefresh(); // ⚠️ 必须在 personaOpen 之后 —— 它读的是 PJ.identity.qq
}

// ── QQ 昵称 / 头像（**跟着人设走**：存进人设包，切换时自动应用）──
async function qqProfileRefresh() {
  // ① 这个人设包里写的值（切到别人时，这两样会跟着变）
  const q = PJ.identity.qq && typeof PJ.identity.qq === 'object' ? PJ.identity.qq : {};
  $('p-nick').value = q.nickname ?? '';
  $('p-avatar-name').textContent = q.avatar ? `文件：${q.avatar}` : '（没设头像）';
  $('p-avatar').src = q.avatar ? `/api/persona/avatar?id=${encodeURIComponent(PJ.id)}&t=${Date.now()}` : '';
  // 生图参考图（立绘）—— 和头像是**两个文件**，见 persona-admin.saveRefImage() 的注释
  const refs = (PJ.identity.image && Array.isArray(PJ.identity.image.refs)) ? PJ.identity.image.refs : [];
  $('p-ref-name').textContent = refs[0] ? `文件：${refs[0]}` : '（没设 —— 生成的脸每次都不一样）';
  $('p-ref').src = refs[0]
    ? `/api/persona/avatar?kind=ref&id=${encodeURIComponent(PJ.id)}&t=${Date.now()}`
    : '';
  $('p-qq-pill').textContent = PJ.id;
  // ② QQ 上**现在**是什么 —— 好让你一眼看出"该不该点立即应用"
  const r = await api('/api/qq/profile');
  $('p-qq-now').textContent =
    r && r.ok
      ? `QQ 上现在：昵称「${r.nickname}」 · 账号 ${r.uin}`
      : `⚠️ 读不到 QQ 上的当前值：${(r && r.error) || '接口没响应'}`;
}

async function qqSaveNick() {
  const nickname = $('p-nick').value.trim();
  const it = JSON.parse(JSON.stringify(PJ.identity));
  it.qq = { ...(it.qq || {}), nickname };
  pjShow($('msg-qqp'), true, '保存中…');
  const r = await api('/api/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: PJ.id, identity: it }),
  });
  if (r && r.ok) {
    PJ.identity = r.identity;
    pjShow($('msg-qqp'), true, '✅ 已存进人设包 —— 以后切到它时会自动改成这个昵称');
    qqProfileRefresh();
  } else {
    pjShow($('msg-qqp'), false, (r && r.error) || '保存失败');
  }
}

async function qqSaveAvatar() {
  const f = $('p-avatar-file').files[0];
  if (!f) {
    pjShow($('msg-qqp'), false, '先选一张图片');
    return;
  }
  pjShow($('msg-qqp'), true, '上传中…');
  const r = await api(
    `/api/persona/avatar?id=${encodeURIComponent(PJ.id)}&name=${encodeURIComponent(f.name)}`,
    { method: 'POST', body: f },
  );
  if (r && r.ok) {
    const ap = r.applied;
    const tail =
      ap && ap.avatar
        ? '，并且已经应用到 QQ 了'
        : ap && ap.problems && ap.problems.length
          ? `（应用到 QQ 时：${ap.problems.join('；')}）`
          : '';
    pjShow($('msg-qqp'), true, `✅ 头像已存进人设包${tail}`);
    await personaOpen(PJ.id);
    qqProfileRefresh();
  } else {
    pjShow($('msg-qqp'), false, (r && r.error) || '上传失败');
  }
}

/** 上传生图参考图（立绘）—— 只存进人设包，**不碰** QQ 头像 */
async function qqSaveRef() {
  const f = $('p-ref-file').files[0];
  if (!f) {
    pjShow($('msg-qqp'), false, '先选一张立绘图');
    return;
  }
  pjShow($('msg-qqp'), true, '上传中…');
  const r = await api(
    `/api/persona/avatar?kind=ref&id=${encodeURIComponent(PJ.id)}&name=${encodeURIComponent(f.name)}`,
    { method: 'POST', body: f },
  );
  if (r && r.ok) {
    await personaOpen(PJ.id);
    qqProfileRefresh();
    pjShow($('msg-qqp'), true, '✅ 立绘已存进人设包 —— 以后这个角色拍照都用它');
  } else {
    pjShow($('msg-qqp'), false, (r && r.error) || '上传失败');
  }
}

async function qqApplyNow() {
  pjShow($('msg-qqp'), true, '应用中…');
  const r = await api('/api/persona/apply-qq', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: PJ.id }),
  });
  if (r && r.ok) {
    pjShow($('msg-qqp'), true, `✅ 已应用到 QQ：昵称「${r.nickname || '没改'}」头像「${r.avatar || '没改'}」`);
  } else {
    const why = r && r.problems && r.problems.length ? r.problems.join('；') : (r && r.error) || '应用失败';
    pjShow($('msg-qqp'), false, `⚠️ ${why}`);
  }
  qqProfileRefresh();
}

/** 「对主人例外」开关的显示（值由 GET /api/persona 搭车带来） */
function paintOwnerException(on) {
  const cb = $('p-exc');
  const pill = $('p-exc-pill');
  if (!cb) return;
  cb.checked = !!on;
  if (pill) pill.textContent = on ? '例外生效（对他）' : '演示模式（对谁都一样）';
}

/**
 * 切换「对主人例外」。
 *
 * ⚠️ 它存在 `config.yml` 的 `persona.ownerException`（**不在** identity.json 里，
 *    因为那是"这次怎么跑"而不是"她是谁"），所以走一般的配置保存。
 *    `saveConfig()` 尾部自带 `reloadConfig()` ⇒ **改完立刻生效，不用重启**。
 * ⚠️ `saveConfig` 是按**逐键覆盖**写的，所以这里只传 ownerException，
 *    不会碰到 `persona.id`（切人设的那个值）。
 */
async function personaSetOwnerException() {
  const on = !!$('p-exc').checked;
  const msg = $('msg-exc');
  if (msg) msg.textContent = '保存中…';
  const r = await api('/api/config', {
    method: 'POST',
    body: JSON.stringify({ persona: { ownerException: on } }),
  });
  if (r && r.ok) {
    paintOwnerException(on);
    if (msg) {
      msg.textContent = on
        ? '✅ 已保存：他还保留例外（已生效）'
        : '✅ 已保存：演示模式 —— 现在对他也一样冷、一样带刺（已生效）';
    }
  } else if (msg) {
    msg.textContent = '❌ ' + ((r && r.error) || '保存失败');
  }
}

function personaPickChange() {
  const id = $('p-pick').value;
  const p = PJ.packs.find((x) => x.id === id);
  const bits = [];
  if (p) bits.push(`${p.docs} 份文档 · ${(p.chars / 1000).toFixed(1)}K 字`);
  if (id === PJ.current) bits.push('（正在用的就是它）');
  if (p && p.broken) bits.push(`⚠️ ${p.broken}`);
  $('p-pick-hint').textContent = bits.join('　');
  // 「删除」那张卡片上的按钮要显示**当前选中哪个** —— 免得点错了还不知道删的是谁
  const del = $('p-del-name');
  if (del) del.textContent = id || '（上面选中的）';
}

/** 打开一个包：拉 identity + 文档清单，渲染表单 */
async function personaOpen(id) {
  if (!id) return;
  const r = await api('/api/persona?id=' + encodeURIComponent(id));
  if (!r || !r.ok) {
    pjShow($('msg-pi'), false, r && r.error ? r.error : '读不出来');
    return;
  }
  PJ.id = r.id;
  PJ.identity = r.identity || {};
  // ⚠️ 2026-09-30：顺手同步「对主人例外」那个开关的显示
  //    （它不在 identity 里，是 config.yml 的 persona.ownerException，
  //     后端在 GET /api/persona 的返回里搭车带过来了）
  paintOwnerException(r.ownerException);
  personaRenderFields();
  personaRenderPrompts();
  const sel = $('p-doc');
  sel.innerHTML = (r.docs || []).map((d) => `<option value="${d.path}">${d.path}　(${d.size} 字节)</option>`).join('');
  await personaLoadDoc();
}

function personaRenderFields() {
  const it = PJ.identity;
  // ⚠️ 2026-09-23 P5：原来每个字段都是 `<div class="row mb8"><div class="f1">` = **全宽单列**，
  //    17 个字段把页面拉得极长 ⇒ 改成栅格：身份 3 列、其余 2 列、JSON 文本框占满整行。
  //  ⚠️ 顺便处理 hint：**以「例：」开头的搬进 placeholder**（它本来就是示例，不是规则），
  //    其余（⚠️ 规则 / 真正要知道的约束）收成 `?` 圆点 —— 一刀切会丢信息。
  // ⚠️⚠️ 2026-10-06：`hintSplit` 原来定义在这里（局部 const）。但 `renderDiceMode()`
  //    也要用它，局部变量在那边不可见 ⇒ 那边一调就抛 `hintSplit is not defined`，
  //    错误又被自己的 catch 吞掉 ⇒ **骰娘那三个触发词输入框从来不出现**，且没人发现。
  //    ⇒ 已提到顶层（和 `escAttr` 放一起）。⚠️ 别再加回来。
  const row = (label, input, hint, cls) => {
    const { ph, tip } = hintSplit(hint);
    // 裸 <input> 默认是 text，但不会命中全局 input[type=text] 样式；这里显式补上。
    const typed = /<input\b(?![^>]*\btype\s*=)/i.test(input)
      ? input.replace('<input ', '<input type="text" ')
      : input;
    return (
      '<div class="fld' + (cls ? ' ' + cls : '') + '">' +
      '<label>' + label + (tip ? '<span class="q" tabindex="0" data-q="' + escAttr(tip) + '">?</span>' : '') + '</label>' +
      typed.replace('<input ', '<input placeholder="' + escAttr(ph) + '" ') +
      '</div>'
    );
  };
  // Tag Input：真正的值放在**旁边的 hidden input**（`、`-分隔）⇒ 收集函数一行都不用改
  const tagRow = (label, id, value, hint, ph, cls, example = '') => {
    const { ph: p2, tip } = hintSplit(hint);
    return (
      '<div class="fld">' +
      '<label>' + label + (tip ? '<span class="q" tabindex="0" data-q="' + escAttr(tip) + '">?</span>' : '') + '</label>' +
      '<div class="tags' + (cls ? ' ' + cls : '') + '" id="tags-' + escAttr(id) + '" data-for="' + escAttr(id) + '"' +
      (example ? ' data-example="' + escAttr(example) + '"' : '') + '>' +
      '<input class="tagadd" placeholder="' + escAttr(p2 || ph || '输入后回车') + '">' +
      '</div>' +
      '<input type="hidden" id="' + escAttr(id) + '" value="' + escAttr(value) + '">' +
      '</div>'
    );
  };
  const key = (k) => '<span class="fkey">' + escHtml(k) + '</span>';
  const out = [];

  out.push('<h3 style="margin:0 0 8px">她是谁</h3><div class="grid3">');
  for (const [k, label, hint] of PJ_STR) {
    out.push(row(label + key(k), `<input id="pf-${k}" value="${escAttr(it[k] ?? '')}">`, hint));
  }
  out.push('</div>');

  out.push('<h3 style="margin:20px 0 8px">别人怎么叫她</h3><div class="gridfull">');
  for (const [k, label, hint, example] of PJ_ARR) {
    const v = Array.isArray(it[k]) ? it[k].join('、') : '';
    out.push(tagRow(label + key(k), `pf-${k}`, v, hint, undefined, 'tags-stacked', example));
  }
  out.push('</div>');

  const an = it.anime && typeof it.anime === 'object' ? it.anime : {};
  out.push('<h3 style="margin:20px 0 8px">动画库与搜索</h3><div class="grid2">');
  // ⚠️ 2026-09-23 第四轮：「读哪几个动画库」从**自由文本**改成
  //    「已选标签 + 下拉（只列现成的库）+ 独立的新建输入框」。
  //    ⚠️ 用户明确要求：**新建不塞进下拉里**（下拉里塞个「新建…」选项很容易被误选），
  //    所以新建是旁边一个单独的小输入框 + 按钮。
  //    ⚠️ 真正的值**仍然是 hidden input**（`、`-分隔）⇒ 收集函数照旧。
  {
    const libs = Array.isArray(PJ.animeLibs) ? PJ.animeLibs : [];
    const opts = libs.map((x) => '<option value="' + escAttr(x) + '">' + escHtml(x) + '</option>').join('');
    out.push(
      '<div class="fld">' +
      '<label>读哪几个动画库' + key('anime.works') +
      '<span class="q" tabindex="0" data-q="' + escAttr('⚠️ 一个名字对应一个文件 knowledge/anime/<名字>.md；没声明就一份都不读（换角色才不会串味）') + '">?</span></label>' +
      '<div class="tags" id="tags-pf-anime-works" data-for="pf-anime-works">' +
      '<input class="tagadd" placeholder="例：bangdream">' +
      '</div>' +
      '<div class="libpick">' +
      '<select id="pf-anime-libpick"><option value="">选一个现成的库加进来…</option>' + opts + '</select>' +
      '<p class="hint">这里只能关联现成库；要新建动画库，请到「知识库 → 动画库」。</p>' +
      '</div>' +
      '<input type="hidden" id="pf-anime-works" value="' + escAttr((an.works || []).join('、')) + '">' +
      '</div>'
    );
  }
  out.push(tagRow('问到这些词要联网搜' + key('anime.keywords'), 'pf-anime-keywords', (an.keywords || []).join('、'),
    '作品名、同作品的角色名', '例：bangdream、丰川祥子'));
  out.push('</div>');

  out.push('<h3 style="margin:20px 0 8px">她怎么称呼别人</h3><div class="grid2">');
  const ad = it.address && typeof it.address === 'object' ? it.address : {};
  for (const [k, label, hint] of PJ_ADDR) {
    out.push(row(label + key('address.' + k), `<input id="pf-addr-${k}" value="${escAttr(ad[k] ?? '')}">`, hint));
  }
  out.push('</div>');
  // ⚠️ 2026-09-28：`address.ownerAliases` **不在这里**了 —— 它搬去了「模型（主人 / 机器人）」页
  //    那张「身份」卡（挨着 `主人 QQ`），因为「别人怎么叫他」是**共用事实**、换人设不该动，
  //    而 `address.*` 管的是"**她**怎么称呼别人"。配置键：`config.ownerAliases`。

  const st = it.style && typeof it.style === 'object' ? it.style : {};
  const tics = Array.isArray(st.verbalTics)
    ? { sentenceStart: st.verbalTics, sentenceEnd: [] }
    : (st.verbalTics && typeof st.verbalTics === 'object' ? st.verbalTics : {});
  out.push('<h3 style="margin:20px 0 8px">口癖</h3><div class="gridfull">');
  out.push(tagRow('句首口癖' + key('style.verbalTics.sentenceStart'), 'pf-tic-start',
    (tics.sentenceStart || []).join('、'), '这个角色自然的句首习惯；反复时只做软提醒', '例：其实'));
  out.push(tagRow('句末口癖' + key('style.verbalTics.sentenceEnd'), 'pf-tic-end',
    (tics.sentenceEnd || []).join('、'), '这个角色自然的句末习惯；反复时只做软提醒', '例：呢'));
  out.push('</div>');

  // ⚠️ 2026-10-22 改成"人话格式"（用户：「这个你考虑一下怎么改」）——
  //    原来这两格直接摆 JSON，普通人根本不敢动。现在：
  //    · 歧义词：每行「名字 = 除非」→ 存回 `[{name, unless}]`
  //    · 不喜欢被叫 / 希望大家叫她：一行一个 / 单行 → 存回 `{dislike:[], prefer:''}`
  out.push('<h3 style="margin:20px 0 8px">歧义词 / 叫法偏好</h3>');
  const ambText = (Array.isArray(it.ambiguity) ? it.ambiguity : [])
    .map((a) => [a?.name || '', a?.unless || ''].filter(Boolean).join(' = '))
    .join('\n');
  out.push(row('歧义词' + key('ambiguity'),
    `<textarea id="pf-ambiguity" rows="3" placeholder="祥子 = 骆驼祥子">${escHtml(ambText)}</textarea>`,
    '每行一组「名字 = 除非」：出现这个名字时，如果上下文里有「除非」那串字，就不算在说她', 'full'));
  const obj = it.renameObjection && typeof it.renameObjection === 'object' ? it.renameObjection : {};
  out.push(row('不喜欢被叫' + key('renameObjection.dislike'),
    `<textarea id="pf-rename" rows="3" placeholder="祥子">${escHtml((Array.isArray(obj.dislike) ? obj.dislike : []).join('\n'))}</textarea>`,
    '一行一个名字；她说自己的时候不会用这些', 'full'));
  out.push(row('希望大家叫她' + key('renameObjection.prefer'),
    `<input id="pf-rename-prefer" placeholder="留空 = 用「自称」那个名字" value="${escAttr(obj.prefer || '')}">`,
    '可选；填了之后别人问她「你叫什么」时优先用这个', 'full'));
  $('p-fields').innerHTML = out.join('');
  for (const [k] of PJ_ARR) tagsSync(`pf-${k}`);
  tagsSync('pf-anime-works');
  tagsSync('pf-anime-keywords');
  tagsSync('pf-tic-start');
  tagsSync('pf-tic-end');
  // ⚠️ 2026-09-28：`pf-addr-ownerAliases` 不在这儿了（搬到「身份」卡，见上面注释）
}

/** 提示词整句的**中文标题**（给用户看）+ 说明。
 *  ⚠️ 2026-09-25 用户：「高级提示词设置似乎并无必要」⇒ 界面**只留常用三句**。
 *     其余键（spokenNames / quest… 等）仍被 speak-judge / quest 等模块使用，
 *     只是不在这里编辑 —— `personaCollectIdentity()` 克隆原 identity、
 *     只覆盖页面上存在的 `pp-<键>`，没渲染的字段会**原样保留**，绝不丢。 */
const PJ_PROMPT_HINT = {
  personaLine: ['自我介绍', '最常出现的那句「你是谁」'],
  styleLine: ['性格与语气', '性格、说话方式的那一段'],
  quickAside: ['紧凑版人设', '只能塞一句时的浓缩版'],
};
/** 界面上**会渲染**的键 —— 只影响摆哪些框；不在表里的后台键照样保存。 */
const PJ_PROMPT_TOP = ['personaLine', 'styleLine', 'quickAside'];

function personaRenderPrompts() {
  const p = PJ.identity.prompt && typeof PJ.identity.prompt === 'object' ? PJ.identity.prompt : {};
  const all = Object.keys(p).filter((k) => k !== '_说明');
  const keys = all.filter((k) => PJ_PROMPT_TOP.includes(k));
  if (!keys.length) {
    // ⚠️ 区分「没有 prompt 段」和「只有后台字段」—— 后者不是空人设，只是这里无可编辑项。
    $('p-prompts').innerHTML = all.length
      ? '<p class="hint">这个人的常用三句没有单独配置；其他后台提示词字段已保留，仍会随人设一起生效。</p>'
      : '<p class="hint">这个人设包还没有 <span class="mono">prompt</span> 段。</p>';
    return;
  }
  const cell = (k) => {
    const meta = PJ_PROMPT_HINT[k];
    const title = meta ? meta[0] : k;
    const tip = meta ? meta[1] : '这个键喂给哪段提示词请看 personas/README.md';
    return (
      '<div class="fld">' +
      '<label>' + escHtml(title) + '<span class="fkey">prompt.' + escHtml(k) + '</span>' +
      // ⚠️ 2026-10-22：`?` 原来放在 `</label>` **后面** ⇒ 被挤到下一行、单独占一行。
      //    挪进 label 里面就贴着标题显示了。
      (tip ? '<span class="q" tabindex="0" data-q="' + escAttr(tip) + '">?</span>' : '') +
      '</label>' +
      '<textarea id="pp-' + escAttr(k) + '" rows="2">' + escHtml(p[k] ?? '') + '</textarea>' +
      '</div>'
    );
  };
  // ⚠️ 三项各自独占一整行（原来挤在两列里读不了整句）；高级折叠区已按用户要求移除。
  // ⚠️ 2026-10-22：小标题「常用（最常改的三句）」删了 —— 这卡本来就叫「提示词里的整句」，
  //    而且现在就这三句，「常用」这个词反而让人以为下面还有别的。
  $('p-prompts').innerHTML = '<div class="gridfull">' + keys.map(cell).join('') + '</div>';
}

const pjList = (s) =>
  String(s || '')
    .split(/[、,，\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

/** 从表单收集出一个完整的 identity（**保留没在界面上出现的键**） */
function personaCollectIdentity() {
  const it = JSON.parse(JSON.stringify(PJ.identity || {}));
  for (const [k] of PJ_STR) it[k] = $('pf-' + k).value.trim();
  for (const [k] of PJ_ARR) {
    const v = pjList($('pf-' + k).value);
    if (v.length) it[k] = v;
    else delete it[k];
  }
  const an = it.anime && typeof it.anime === 'object' ? it.anime : {};
  const works = pjList($('pf-anime-works').value);
  const kws = pjList($('pf-anime-keywords').value);
  if (works.length) an.works = works;
  else delete an.works;
  if (kws.length) an.keywords = kws;
  else delete an.keywords;
  if (Object.keys(an).length) it.anime = an;
  else delete it.anime;

  const ad = it.address && typeof it.address === 'object' ? it.address : {};
  for (const [k] of PJ_ADDR) {
    const v = $('pf-addr-' + k).value.trim();
    if (v) ad[k] = v;
    else delete ad[k];
  }
  // ⚠️ 2026-09-28：`address.ownerAliases` 的收集**从这里移走了** ——
  //    它现在跟着「模型（主人 / 机器人）」页那张「身份」卡走（`saveIdentity()` 里
  //    跟 `ownerQQ` 一起提交 `config.ownerAliases`）。
  //    ⚠️ 别把它塞回上面那个循环：那个一律按**字符串**存，会写成「粥粥、舟老师」
  //    一整串，`persona.ownerAliases()` 读出来就是一个乱码条目（界面看着还挺正常）。
  it.address = ad;

  const st = it.style && typeof it.style === 'object' ? it.style : {};
  const sentenceStart = pjList($('pf-tic-start').value);
  const sentenceEnd = pjList($('pf-tic-end').value);
  if (sentenceStart.length || sentenceEnd.length) {
    st.verbalTics = { sentenceStart, sentenceEnd };
  } else {
    delete st.verbalTics;
  }
  it.style = st;

  // ⚠️ 2026-10-22：这两项不再是 JSON.parse —— 界面换成人话格式，这里负责解析回原结构。
  //    `renameObjection` 有 `dislike`（数组）和 `prefer`（字符串）两个字段，都要收。
  it.ambiguity = String($('pf-ambiguity')?.value || '')
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split(/\s*=\s*/);
      return { name: String(parts[0] || '').trim(), unless: String(parts.slice(1).join(' = ') || '').trim() };
    })
    .filter((a) => a.name || a.unless);
  const dislike = String($('pf-rename')?.value || '')
    .split(/\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  const prefer = String($('pf-rename-prefer')?.value || '').trim();
  it.renameObjection = dislike.length || prefer ? { dislike, ...(prefer ? { prefer } : {}) } : {};

  const pr = it.prompt && typeof it.prompt === 'object' ? it.prompt : {};
  for (const k of Object.keys(pr)) {
    if (k === '_说明') continue;
    const el = $('pp-' + k);
    if (el) pr[k] = el.value;
  }
  it.prompt = pr;
  return it;
}

/** 未保存标记：改动任一输入框就亮点。**只提醒，不拦保存、不拦切页**。 */
function pjDirtyClear() {
  const d = $('p-dirty');
  if (d) d.classList.remove('on');
  const t = $('p-dirtytext');
  if (t) t.textContent = '下面两张卡（结构化设置 / 提示词整句）改了都要存';
  const b = $('p-save');
  if (b) b.textContent = '保存';
  const v = $('p-savebar');
  if (v) { const e = v.querySelector('.pverr'); if (e) e.remove(); }
}

function pjDirty() {
  const d = $('p-dirty');
  if (d) d.classList.add('on');
  const t = $('p-dirtytext');
  if (t) t.textContent = '有改动还没存（结构化设置 / 提示词整句）';
  for (const id of ['p-save']) { const b = $(id); if (b) b.textContent = '保存 ●'; }
}

/** 保存前的前端校验（**只提示，不拦保存** —— 服务端才是最终裁决）。
 *  ⚠️ 与 learned.md 那套实时校验同思路：把「存下去才会报错」的东西提前露出来。 */
function pjValidate() {
  const box = $('p-savebar');
  if (!box) return null;
  let old = box.querySelector('.pverr');
  if (old) old.remove();
  const bad = [];
  // 1) 名字：至少要有一个（角色全名 / 自称 / 对外显示身份）
  const nm = ['name', 'selfName', 'displayName'].map((k) => $('pf-' + k) ? $('pf-' + k).value.trim() : '').filter(Boolean);
  if (!nm.length) bad.push('角色全名 / 自称 / 对外显示身份 三项至少填一个，否则提示词里没有名字');
  // 2) Tag 字段里不能有重复（重复的名字匹配会命中两遍）
  for (const k of ['selfNames', 'callNames', 'nicknames', 'matchNames']) {
    const el = $('pf-' + k); if (!el) continue;
    const arr = el.value.split(/[、,，\n]/).map((x) => x.trim()).filter(Boolean);
    const dup = arr.filter((x, i) => arr.indexOf(x) !== i);
    if (dup.length) bad.push('「' + k + '」里有重复：' + [...new Set(dup)].join('、'));
  }
  // 3) 动画库：选了但没保存成功的话，下拉里根本选不到 —— 这里只提醒别填错名
  const aw = $('pf-anime-works');
  if (aw && aw.value.trim() && !PJ.animeLibs) bad.push('读不到现有动画库列表，先确认服务在跑');
  if (!bad.length) return null;
  const d = document.createElement('div');
  d.className = 'warn pverr';
  d.innerHTML = '⚠️ ' + bad.map((b) => esc(b)).join('<br>');
  box.insertBefore(d, box.firstChild);
  return bad;
}

async function personaSaveIdentity() {
  // ⚠️ 2026-09-23：保存前先跑一遍前端校验（名字缺失 / Tag 重复 / 动画库读不到），
  //    **只提示、不拦** —— 服务端才是最终裁决。
  pjValidate();
  let identity;
  try {
    identity = personaCollectIdentity();
  } catch (e) {
    pjShow($('msg-pi'), false, 'JSON 写坏了：' + e.message);
    return;
  }
  pjShow($('msg-pi'), true, '保存中…');
  const r = await api('/api/persona', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: PJ.id, identity }),
  });
  if (r && r.ok) {
    PJ.identity = r.identity;
    pjDirtyClear();
    pjShow($('msg-pi'), true, r.reloaded ? '✅ 存好了，已热重载（没重启）' : '✅ 存好了（这个包当前没在用）');
    pjShow($('msg-pp'), true, '✅ 存好了');
    await personaRefresh();
  } else {
    pjShow($('msg-pi'), false, (r && r.error) || '保存失败');
  }
}

async function personaSwitch() {
  const id = $('p-pick').value;
  // ⚠️⚠️ 2026-10-09 加：**二次确认**。
  //
  //    踩到的（用户报「主号怎么变成别人的人设了，**不是我改的**」）：日志查出来是
  //    界面上点了一下「切到这个」⇒ 当场热重载、人格就换了，**没有任何确认**。
  //    而人设页和「编辑知识文件」在一个页面里，误点的成本极高。
  //
  //    ⚠️ 更要紧的是**它只改当前这个号**：`persona` 不在 `SHARED_SECTIONS` 里，
  //    `splitPatch()` 把它写进 `accounts/<当前号>.yml`，`config.yml` **一个字不动**
  //    ⇒ 别的号不受影响，但界面上过去只回一句「已切到 xxx」，看不出这个范围。
  if (!confirm(
    `把当前这个号切换成人设「${id}」？\n\n` +
    `· 只影响**当前正在控制的这个号**（写进它自己的账号配置，别的号不变）\n` +
    `· 会顺手把 QQ 昵称 / 头像换成这个人设声明的那份\n` +
    `· 当场生效，不用重启机器人`
  )) return;
  // ⚠️ 反馈要显示在**这张卡片里**（`msg-p-switch`）——
  //    原来用的 `msg-p` 在下面「新建人设」那张卡片里，用户点了按钮**什么都看不见**，
  //    于是报「这个好像切不动」（2026-09-22 真踩了）。
  pjShow($('msg-p-switch'), true, '切换中…');
  const r = await api('/api/persona/switch', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (r && r.ok) {
    const q = r.qqApply || {};
    let tail = '';
    if (q.nickname || q.avatar) tail = `，QQ 昵称头像也换成了「${q.nickname || '—'}」/「${q.avatar || '—'}」`;
    if (q.problems && q.problems.length) tail += `（⚠️ QQ 资料没全换上：${q.problems.join('；')}）`;
    // ⚠️ 说清"只改了哪个号、写进了哪个文件" —— 不然用户会以为整个机器人换了人设。
    const scope = r.account ? `，**只改了号 ${r.account}**` : '';
    const wrote = r.wrote ? `（写进 ${r.wrote}）` : '';
    pjShow($('msg-p-switch'), true, `✅ 已经切到「${id}」，立刻生效（没重启机器人）${scope}${wrote}${tail}`);
    await personaRefresh();
    await reloadAll();
    await loadKnowledgeList(true);
  } else {
    pjShow($('msg-p-switch'), false, (r && r.error) || '切换失败');
  }
}

async function personaCreate() {
  const id = $('p-new-id').value.trim();
  const name = $('p-draft-name').value.trim();
  const from = $('p-new-from')?.value || '_template';
  if (!id) {
    pjShow($('msg-p'), false, '先填一个 id');
    return;
  }
  if (!name) {
    pjShow($('msg-p'), false, '填一下角色名');
    return;
  }
  const primary = $('p-new-primary');
  if (primary) primary.disabled = true;
  pjShow($('msg-p'), true, '创建中…');
  try {
    const r = await api('/api/persona/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, from }),
    });
    if (!r || !r.ok) {
      pjShow($('msg-p'), false, (r && r.error) || '新建失败');
      return;
    }

    // 手动路径也消费统一表单：角色名直接落 identity.name，作品名落检索关键词，
    // 动画库直接落 anime.works。identity.work 是「身份 / 职业」，不能拿来冒充作品名。
    const pack = await api('/api/persona?id=' + encodeURIComponent(id));
    if (!pack || !pack.ok) {
      pjShow(
        $('msg-p'),
        false,
        `⚠️ 人设包「${id}」已创建，但基础字段没保存：${(pack && pack.error) || '新包读取失败'}`,
      );
    } else {
      const identity = JSON.parse(JSON.stringify(pack.identity || {}));
      const work = $('p-draft-work').value.trim();
      identity.name = name;
      identity.anime = { ...(identity.anime || {}) };
      if (work) {
        const keywords = Array.isArray(identity.anime.keywords) ? identity.anime.keywords.map(String) : [];
        if (!keywords.includes(work)) keywords.unshift(work);
        identity.anime.keywords = keywords;
      }
      const saved = await api('/api/persona', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, identity }),
      });
      if (!saved || !saved.ok) {
        pjShow($('msg-p'), false, `⚠️ 人设包「${id}」已创建，但基础字段没保存：${(saved && saved.error) || '未知错误'}`);
      }
    }

    if (!String($('msg-p').textContent).startsWith('⚠️')) {
      pjShow($('msg-p'), true, `✅ 建好了「${id}」（${from === '_template' ? '标准模板' : '照 ' + from + ' 复制'}）—— 正在打开它`);
    }
    $('p-new-id').value = '';
    await personaRefresh();
    $('p-pick').value = id;
    personaPickChange();
    await personaOpen(id);
  } finally {
    if (primary) primary.disabled = false;
  }
}

async function personaDelete() {
  const id = $('p-pick').value;
  if (!id) return;
  if (!confirm(`确定删除人设包「${id}」？\n\n它是**挪走**（logs/persona-removed-*，还会留一份 persona.md），不是真销毁。`)) return;
  const r = await api('/api/persona/delete', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id }),
  });
  if (r && r.ok) {
    pjShow($('msg-p'), true, `✅ 「${id}」已挪走`);
    await personaRefresh();
  } else {
    pjShow($('msg-p'), false, (r && r.error) || '删除失败');
  }
}

function personaDocCount() {
  const text = $('p-doc-text')?.value ?? '';
  const el = $('p-doc-count');
  if (el) el.textContent = `${text.length} 字`;
}

function personaDocGutter() {
  const text = $('p-doc-text')?.value ?? '';
  const el = $('p-doc-gutter');
  if (el) el.textContent = Array.from({ length: Math.max(1, text.split(/\r?\n/).length) }, (_, i) => i + 1).join('\n');
}

function personaDocPreview() {
  const text = $('p-doc-text')?.value ?? '';
  const el = $('p-doc-preview');
  if (el) el.innerHTML = text ? kMarkdown(text) : '<p class="empty">这个文件还没有内容</p>';
}

function personaDocDirty(on = true) {
  const d = $('p-doc-dirty');
  if (d) d.classList.toggle('on', !!on);
  const save = $('p-doc-save');
  if (save && !save.disabled) save.textContent = on ? '保存 ●' : '保存';
}

/** 人设文档：预览 / 编辑切换，和知识库页保持同一套交互。 */
function personaDocMode(m) {
  const isEdit = m !== 'prev';
  $('p-doc-mode-edit').classList.toggle('on', isEdit);
  $('p-doc-mode-prev').classList.toggle('on', !isEdit);
  $('p-doc-editwrap').classList.toggle('hidden', !isEdit);
  $('p-doc-preview').classList.toggle('hidden', isEdit);
  if (isEdit) personaDocGutter();
  else personaDocPreview();
}

async function personaDocReload() {
  if (await personaLoadDoc()) pjShow($('msg-pd'), true, '已重新读取');
}

async function personaLoadDoc() {
  const path = $('p-doc').value;
  if (!path) {
    $('p-doc-text').value = '';
    personaDocCount();
    personaDocDirty(false);
    personaDocMode('prev');
    return false;
  }
  const r = await api('/api/persona/doc?id=' + encodeURIComponent(PJ.id) + '&path=' + encodeURIComponent(path));
  if (!r || !r.ok) {
    $('p-doc-text').value = '';
    personaDocCount();
    personaDocDirty(false);
    personaDocMode('prev');
    $('p-doc-preview').textContent = '（读取失败：' + (r?.error || '未知错误') + '）';
    pjShow($('msg-pd'), false, r?.error || '读不出来');
    return false;
  }
  $('p-doc-text').value = r.text || '';
  personaDocCount();
  personaDocDirty(false);
  personaDocMode('prev');
  $('msg-pd').textContent = '';
  return true;
}

async function personaSaveDoc() {
  const path = $('p-doc').value;
  if (!path) return;
  pjShow($('msg-pd'), true, '保存中…');
  const r = await api('/api/persona/doc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: PJ.id, path, text: $('p-doc-text').value }),
  });
  if (r && r.ok) {
    // 只重读当前文档；不要 personaOpen()，否则会把身份卡里尚未保存的输入一起重置。
    const message = r.reloaded ? '✅ 存好了，已热重载（没重启）' : '✅ 存好了';
    await personaLoadDoc();
    pjShow($('msg-pd'), true, message);
  } else {
    pjShow($('msg-pd'), false, (r && r.error) || '保存失败');
  }
}
// ─────────────────────────────────────────────────────────────
// 联网自动填（P3）：角色名 + 作品 → 搜资料 → 模型起草 → 你过一眼 → 保存
// ─────────────────────────────────────────────────────────────
//
// ⚠️ 起草在服务端（`src/persona-draft.js`）**只产出、不落盘**；
//    "保存"这一步才走 `/api/persona/create` + `/api/persona` + `/api/persona/doc`。
// ⚠️ 保存完**自动打开那个人设包** —— 这样能立刻用上面的完整表单**逐节改**
//    （起草出来的东西一次到位是不可能的，必须留个"改"的入口）。

let PDRAFT = null;

async function personaDraftStart() {
  const id = $('p-new-id').value.trim();
  const name = $('p-draft-name').value.trim();
  const work = $('p-draft-work').value.trim();
  if (!id) {
    pjShow($('msg-p'), false, '先在「新建」那里填一个 id（小写字母数字）');
    return;
  }
  if (!name) {
    pjShow($('msg-p'), false, '填一下角色名');
    return;
  }
  $('p-new-primary').disabled = true;
  pjShow($('msg-p'), true, '联网搜资料 + 起草中…（30~60 秒，别关页面）');
  try {
    const r = await api('/api/persona/draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        name,
        work,
      }),
    });
    if (!r || !r.ok) {
      pjShow($('msg-p'), false, (r && r.error) || '起草失败');
      return;
    }
    if (r.blocked) {
      pjShow($('msg-p'), false, `⛔ 不做这个：${r.why}`);
      return;
    }
    PDRAFT = r;
    pjShow($('msg-p'), true, `✅ 起草好了（参考了 ${r.sources?.length ?? 0} 条资料）—— 下面过一眼再保存`);
    renderDraft();
  } catch (e) {
    pjShow($('msg-p'), false, '起草出错：' + e.message);
  } finally {
    $('p-new-primary').disabled = false;
  }
}

function renderDraft() {
  const box = $('p-draft');
  if (!PDRAFT) {
    box.innerHTML = '';
    return;
  }
  const notes = (PDRAFT.notes || []).map((n) => `· ${escHtml(n)}`).join('<br>');
  const src = (PDRAFT.sources || [])
    .map((s) => `<a href="${escAttr(s.url)}" target="_blank" rel="noreferrer">${escHtml(s.title || s.url)}</a>`)
    .join('　');
  const fill =
    PDRAFT.totalFields != null
      ? `<p class="hint">模板字段：<b>${PDRAFT.filledFields} / ${PDRAFT.totalFields}</b> 填上了` +
        (PDRAFT.filledFields < PDRAFT.totalFields
          ? '（其余留空 —— 看上面那条提醒）'
          : '（一个都没漏）') +
        '</p>'
      : '';
  box.innerHTML =
    '<h2 style="margin-top:18px">起草结果（还没保存）</h2>' +
    fill +
    (notes ? `<p class="hint">⚠️ 提醒：<br>${notes}</p>` : '') +
    (src
      ? `<p class="hint">资料来自：${src}</p>`
      : '<p class="hint">⚠️ 一条资料都没搜到 —— 这份是模型凭自己的知识写的，务必仔细核对。</p>') +
    '<label>identity.json（可直接改；保存时会校验）</label>' +
    `<textarea id="pd-identity" rows="18">${escHtml(JSON.stringify(PDRAFT.identity, null, 2))}</textarea>` +
    '<label class="mt10">persona.md（≤3000 字）</label>' +
    `<textarea id="pd-persona" rows="14">${escHtml(PDRAFT.docs?.['persona.md'] || '')}</textarea>` +
    '<label class="mt10">voices.md（示例对话 —— 人味就靠它）</label>' +
    `<textarea id="pd-voices" rows="12">${escHtml(PDRAFT.docs?.['voices.md'] || '')}</textarea>` +
    // ⚠️ 2026-10-13 加（用户要求：「以后建新人设时这种人际关系也要能摘下来」）：
    //    cast.md = 出场人物表 / 人际关系。起草时模型会从
    //    `personas/_template/relations.md` 的片段库里挑几条落成它。
    '<label style="margin-top:10px">cast.md（出场人物表 / 人际关系 —— 从片段库里摘的）</label>' +
    `<textarea id="pd-cast" rows="12">${escHtml(PDRAFT.docs?.['cast.md'] || '')}</textarea>` +
/* ⚠️ 2026-10-22 加（用户：「补，然后**以后自动生成时要自动加好**」）：
     *   以前起草**不产** life-events.md，只在提醒里说一句"照模板填" ⇒
     *   新角色没有事件库 ⇒ 每天的日常事件一条都发不出来（爱音哑了好几天就是这个）✗
     *   ⇒ 现在起草就产，这里给个编辑框，保存时落盘 ✓ */
    '<label style="margin-top:10px">life-events.md（日常事件库 —— 每段 ≥12 条、全篇 ≥90、0 条台词）</label>' +
    `<textarea id="pd-life" rows="18">${escHtml(PDRAFT.docs?.['life-events.md'] || '')}</textarea>` +
    /* ⚠️ 2026-10-22 加（用户：「**b站那边评论要用到的人设在新建时也要完善好，
     *   和 QQ 这边一样，之前我说过的机器人味不能出现**」）
     *   ⇒ 起草时也要产这一份，落到 `prompt/bili-comment.md`
     *   ⚠️ 少了它，B站评论/主动评论会**回落到内置的祥子那份** ⇒ 新角色在 B 站上说话是祥子腔 ✗ */
    '<label style="margin-top:10px">prompt/bili-comment.md（B 站用的精简版，≤1500 字）' +
      '<span class="hint" style="display:inline;margin-left:8px">B站评论 / 主动评论 / 视频文案都读它</span></label>' +
    `<textarea id="pd-bili" rows="16">${escHtml(PDRAFT.docs?.['bili-comment.md'] || '')}</textarea>` +
    (PDRAFT.animeLibName
      ? '<label style="margin-top:10px">新建的动画库 ' +
        escHtml(PDRAFT.animeLibName) +
        '（保存时写进 knowledge/anime/）</label>' +
        `<textarea id="pd-animelib" rows="12">${escHtml(PDRAFT.animeLib || '')}</textarea>`
      : '') +    '<div class="btns">' +
    '<button class="act" onclick="personaDraftSave()">保存成新人设包</button>' +
    '<button onclick="personaDraftDrop()">不要了</button>' +
    '<span class="msg" id="msg-pd2"></span>' +
    '</div>';
}

function personaDraftDrop() {
  PDRAFT = null;
  renderDraft();
  pjShow($('msg-p'), true, '草稿丢了（没写盘，什么都没变）');
}

async function personaDraftSave() {
  const id = $('p-new-id').value.trim();
  let identity;
  try {
    identity = JSON.parse($('pd-identity').value);
  } catch (e) {
    pjShow($('msg-pd2'), false, 'identity.json 有问题：' + e.message);
    return;
  }
  pjShow($('msg-pd2'), true, '保存中…');
  const post = (path, body) =>
    api(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

  const c = await post('/api/persona/create', { id, from: '_template' });
  if (!c || !c.ok) {
    pjShow($('msg-pd2'), false, (c && c.error) || '建包失败');
    return;
  }
  const s = await post('/api/persona', { id, identity });
  if (!s || !s.ok) {
    pjShow($('msg-pd2'), false, (s && s.error) || '写 identity 失败');
    return;
  }
  for (const [path, key] of [
    ['persona.md', 'pd-persona'],
    ['voices.md', 'pd-voices'],
    // ⚠️ 2026-10-13 加：人际关系（出场人物表）也要落盘
    ['cast.md', 'pd-cast'],
    // ⚠️ 2026-10-22 加：**B 站那边用的精简版**（用户要求「新建时也要完善好」）
    //    落点是 `prompt/bili-comment.md`（`DOC_RE` 允许 `prompt/` 前缀）
    ['prompt/bili-comment.md', 'pd-bili'],
    // ⚠️ 2026-10-22 加：**日常事件库**（用户：「以后自动生成时要自动加好」）
    ['life-events.md', 'pd-life'],
  ]) {
    const el = $(key);
    if (!el) continue; // 旧界面/缺元素时不炸
    const text = el.value;
    if (!text.trim()) continue;
    const d = await post('/api/persona/doc', { id, path, text });
    if (!d || !d.ok) {
      pjShow($('msg-pd2'), false, `${path} 写失败：${(d && d.error) || ''}`);
      return;
    }
  }
  PDRAFT = null;
  renderDraft();
  $('p-new-id').value = '';
  await personaRefresh();
  $('p-pick').value = id;
  personaPickChange();
  await personaOpen(id);
  pjShow($('msg-p'), true, `✅ 新人设「${id}」建好了 —— 上面就是它，可以逐节改；要启用就点「切到这个」`);
}

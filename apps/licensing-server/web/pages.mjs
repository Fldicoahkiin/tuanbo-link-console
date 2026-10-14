const origin = 'https://tuanbo-link.jinhefilm.com';
const asset = name => `/assets/20261010-${name}.webp`;
const image = (name, alt, eager = false) => `<a class="product-image" href="${asset(name)}" data-image aria-label="放大查看：${alt}"><img src="${asset(name)}" alt="${alt}" width="1440" height="900" ${eager ? 'fetchpriority="high"' : 'loading="lazy"'}><span class="image-zoom">放大查看 ↗</span></a>`;
const note = '<p class="media-note">0.4.46 开发预览 · 真实软件操作录屏，无配音。机位使用专用 OBS 示例场景，灯光展示离线编排；正式版本见下载页。</p>';
const features = [
  ['programs', '01', '节目编排', '排好一场节目的顺序', '导入音乐，整理节目单。每首节目的画面和灯光分别保存，排练时按节目检查。', '节目单、音乐波形与播放控制', '按节目管理', '保存编排，重复使用'],
  ['timeline', '02', '素材播放', '把素材放到需要的位置', '对照音乐波形安排视频和图片，调整开始位置与播放时长。', '音乐波形、背景素材与多轨时间线', '对照波形定位', '调整片段的位置与时长'],
  ['cameras', '03', '机位切换', '提前安排机位切换', '将已有 OBS 机位场景放进时间线，在指定位置切换画面。', '机位 A、机位 B 与切换片段', '继续使用 OBS 场景', '保留场景中的裁剪与滤镜'],
  ['lighting', '04', '灯光编辑', '沿着音乐编辑灯光', '把控台 Cue 排到灯光轨道，移动、复制和组合，调整灯光变化的位置。', '灯光素材库、Cue 与音乐时间线', '在时间线上调整 Cue', '灯具参数由控台管理']
];

export function layout(title, path, body, purchase = false) {
  const description = '团播联动台：节目编排、素材播放、机位切换、灯光编辑。像剪辑一样，围绕音乐时间线编排直播。Windows 桌面软件。';
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="color-scheme" content="light"><meta name="referrer" content="no-referrer"><title>${title} · 团播联动台</title><meta name="description" content="${description}"><link rel="canonical" href="${origin}${path}"><meta property="og:title" content="${title} · 团播联动台"><meta property="og:description" content="${description}"><meta property="og:type" content="website"><meta property="og:url" content="${origin}${path}"><meta property="og:image" content="${origin}${asset('timeline')}"><link rel="stylesheet" href="/site.css">${purchase ? '<link rel="stylesheet" href="/purchase.css">' : ''}<script type="module" src="/${purchase ? 'purchase' : 'site'}.js"></script></head>
<body><a class="skip-link" href="#main">跳到正文</a><header class="site-header"><div class="header-inner"><a class="brand" href="/" aria-label="团播联动台首页"><span class="brand-mark" aria-hidden="true"><i></i><i></i><i></i></span>团播联动台</a><nav aria-label="页面导航"><a href="/#features">产品功能</a><a href="/#demo">操作演示</a><a href="/guide/" ${path === '/guide/' ? 'aria-current="page"' : ''}>使用指南</a><a href="/download/" ${path === '/download/' ? 'aria-current="page"' : ''}>下载</a></nav><a class="button small" href="/purchase/">购买授权</a></div></header>
<main id="main">${body}</main><footer><a class="brand" href="/">团播联动台</a><div><a href="/guide/">使用指南</a><a href="/purchase/#receipt">恢复订单</a><a href="mailto:info@jinhefilm.com">联系支持</a><a href="/terms/">服务条款</a><a href="/refund/">退款政策</a><a href="/privacy/">隐私政策</a></div><p>Windows 节目编排与设备联动软件</p><a class="filing" href="https://beian.miit.gov.cn/" target="_blank" rel="noopener noreferrer">蜀ICP备2026056101号-2</a></footer>${purchase ? '' : '<dialog id="image-viewer" aria-label="软件界面大图"><button type="button" class="viewer-close" aria-label="关闭大图">关闭 ×</button><img alt=""><p></p></dialog>'}</body></html>`;
}

export function homepage() {
  return layout('像剪辑一样，编排直播', '/', `<section class="hero wrap"><p class="eyebrow">团播现场 / WINDOWS</p><div class="hero-heading"><div><h1>像剪辑一样，编排直播。</h1><p class="lead">提前排好节目、播放素材、切换机位、编辑灯光。<br>围绕音乐时间线安排现场操作。</p></div><div class="hero-actions"><a class="button" href="#demo">观看操作演示 <span aria-hidden="true">↗</span></a><a class="button secondary" href="/download/">下载 Windows 版</a><span class="fine">使用需购买授权</span></div></div><figure class="hero-product">${image('timeline', '团播联动台：音乐、素材和机位编排工作区', true)}<figcaption><span>音乐的位置，也是画面与灯光的位置。</span><span>0.4.46 开发预览</span></figcaption></figure><div class="feature-index" aria-label="四项核心功能">${features.map(([id, n, label]) => `<a href="#${id}"><span>${n}</span>${label}<span aria-hidden="true">↓</span></a>`).join('')}</div></section>
<section class="advantages wrap" aria-labelledby="advantages-title"><h2 id="advantages-title">重复的操作，提前排好。</h2><div><p><strong>对照音乐调整</strong>在波形上找位置，移动素材、机位和灯光事件。</p><p><strong>按节目保存</strong>编排跟着节目走，下次排练继续修改和使用。</p><p><strong>接着用现有设备</strong>OBS 场景、P1 与 MA2，各自保留原有分工。</p></div></section>
<div id="features" class="wrap features">${features.map(([id, n, label, heading, text, alt, a, b]) => `<section class="feature" id="${id}"><div class="feature-copy"><p class="eyebrow">${n} / ${label}</p><h2>${heading}</h2><p>${text}</p><ul class="feature-facts"><li>${a}</li><li>${b}</li></ul><button class="text-button" type="button" data-clip="${id}" data-title="${label}">观看${label}操作 <span aria-hidden="true">↗</span></button></div><figure>${image(id, alt)}<figcaption>${label} · 0.4.46 开发预览${id === 'lighting' ? ' · 离线编辑' : ''}</figcaption></figure></section>`).join('')}</div>
<section id="demo" class="demo-section"><div class="wrap"><div class="section-heading"><div><p class="eyebrow">操作演示</p><h2 id="demo-title">一首节目，从编排到播放。</h2></div><p>看实际操作，了解每一步怎么做。</p></div><video id="demo-player" controls playsinline preload="none" poster="${asset('timeline')}" aria-labelledby="demo-title"><source src="/media/20261010-overview.mp4" type="video/mp4"><track kind="subtitles" src="/media/20261010-overview.vtt" srclang="zh" label="简体中文" default>浏览器无法播放视频，请下载后观看。</video><div class="chapters" aria-label="演示章节"><button data-time="0">00:00 节目编排</button><button data-time="20">00:20 素材播放</button><button data-time="40">00:40 机位切换</button><button data-time="60">01:00 灯光编辑</button></div><p id="video-status" role="status"></p>${note}<a class="text-link" href="/media/20261010-overview.mp4" download>下载演示视频</a></div></section>
<section class="wrap connections"><div><p class="eyebrow">接入现场</p><h2>保留熟悉的工作方式。</h2><p>用联动台播放音乐，或跟随 P1 时间码。<br>开始前明确选择主控方式。</p></div><dl><div><dt>OBS Studio</dt><dd>场景、机位、素材解码与正式画面输出。</dd></div><div><dt>P1</dt><dd>外部音乐播放与时间码；也可选择联动台内部播放。</dd></div><div><dt>grandMA2</dt><dd>灯光 Cue、执行器和灯具参数。联动台负责编排调用与时间。</dd></div></dl></section>
<section id="purchase" class="wrap home-pricing"><div class="section-heading"><div><p class="eyebrow">授权</p><h2>按使用周期选择。</h2></div><p>每份授权绑定一台电脑，主动续费，不自动扣款。</p></div><div id="catalog-plans" class="catalog-plans" aria-live="polite"><p>正在读取可售套餐…</p></div><button id="catalog-reload" class="text-button" type="button" hidden>重新读取套餐</button><p class="fine">无免费版或试用。首次核款发码后起算，每次启动须联网验证。</p><a class="text-link" href="/purchase/#receipt">已有订单？恢复并领取激活码 ↗</a></section>
<section class="wrap faq"><h2>购买前，你可能想了解。</h2><details><summary>需要什么电脑和软件？</summary><p>联动台运行于 Windows x64。画面联动需要 OBS Studio；灯光联动需配置相应控台和连接线路。安装与接入步骤见<a href="/guide/">使用指南</a>。</p></details><details><summary>灯光编辑包括哪些内容？</summary><p>编排 Cue 的调用、顺序和时间，支持在音乐时间线上调整。灯具颜色、位置等 Cue 内部参数由控台编辑。播放中的本地编辑与停止后的同步有不同规则，接入前请先排练核对。</p></details><details><summary>截图和下载版本是否一致？</summary><p>本页素材来自 0.4.46 开发预览，部分功能尚未进入当前正式下载版本。购买前请核对<a href="/download/">正式版本说明</a>，或联系支持确认所需功能。</p></details><details><summary>换电脑、续费和售后怎么办？</summary><p>换机需联系支持迁移；续费在已激活电脑的软件内办理。请提供订单号，不要发送完整激活码或订单凭据。</p></details></section>
<section id="contact" class="wrap contact"><div><h2>了解清楚，再接入现场。</h2><p>功能、设备接入、企业多机或售后问题，都可以通过邮件联系。</p></div><a href="mailto:info@jinhefilm.com">info@jinhefilm.com ↗</a></section>`);
}

export function downloadPage(release) {
  return layout('下载 Windows 版', '/download/', `<section class="wrap page-intro"><p class="eyebrow">下载</p><h1>团播联动台 · Windows 版</h1><p class="lead">下载正式安装包，在电脑上安装并激活。</p></section><section class="wrap download-layout"><div class="download-panel"><span class="eyebrow">正式发行</span><h2>${release.version}</h2><p>Windows x64 · ${release.date} 发布</p><a class="button" href="${release.url}">下载安装包 <span aria-hidden="true">↓</span></a><p class="fine">使用需购买授权，无免费试用。</p><a href="/purchase/">查看授权与购买</a></div><div><h2>安装前</h2><ol class="steps"><li><strong>保存工程并退出软件</strong><p>已有安装可覆盖原目录升级，先保存当前节目。</p></li><li><strong>运行安装包</strong><p>当前正式安装包未做代码签名，Windows 可能提示未知发布者。</p></li><li><strong>联网激活</strong><p>输入购买后领取的激活码。每份授权绑定一台电脑，每次启动需要联网验证。</p></li></ol></div></section><section class="wrap release-notes"><h2>版本与演示说明</h2><p>当前正式下载：${release.version}。官网截图和操作视频来自 0.4.46 开发预览，不能代表这些功能已全部包含在正式安装包中。</p><h3>${release.version} 正式发行</h3><p>使用公司 HTTPS 更新源；无需 GitHub Token。提供 Windows x64 安装包和软件内更新入口。</p><p>灯光、OBS 和时间码接入需按实际设备环境排练确认。升级及设备接入问题请联系 <a href="mailto:info@jinhefilm.com">info@jinhefilm.com</a>。</p><a class="text-link" href="/guide/">阅读首次使用指南 ↗</a></section>`);
}

export function guidePage() {
  const steps = [
    ['建立节目', '新建并保存工程，把开场、主节目和返场按顺序放进节目单。每首节目保留自己的编排。', 'programs'],
    ['导入素材', '导入音乐以及需要使用的视频和图片。对照波形调整素材的开始位置与时长。', 'timeline'],
    ['接入 OBS', '在设置的设备连接中配置 OBS，并检查预览组件。每个机位使用一个已有 OBS 场景。', 'connections'],
    ['编排机位', '将机位场景安排到对应时间位置，核对机位片段结束后的下层素材接续。', 'cameras'],
    ['添加灯光', '从灯光素材库选择 Cue，放入灯光轨道并调整位置。联动台编排调用和时间，灯具参数仍在控台中编辑。', 'lighting'],
    ['排练检查', '明确选择内部音乐主控或 P1 跟随，检查设备与时间码状态，再播放测试节目。确认画面、音乐和灯光对应后再用于现场。', 'rehearsal']
  ];
  return layout('首次使用指南', '/guide/', `<section class="wrap page-intro"><p class="eyebrow">使用指南</p><h1>从第一首节目开始。</h1><p class="lead">先完成编排，再连接设备排练。</p>${note}</section><div class="wrap guide-layout"><nav aria-label="指南章节">${steps.map(([title], i) => `<a href="#step-${i + 1}">${String(i + 1).padStart(2, '0')} ${title}</a>`).join('')}</nav><div>${steps.map(([title, text, file], i) => `<section class="guide-step" id="step-${i + 1}"><p class="eyebrow">${String(i + 1).padStart(2, '0')} / 首次使用</p><h2>${title}</h2><p>${text}</p>${image(file, title + '的真实软件界面')}</section>`).join('')}<section class="guide-step"><h2>两种音乐主控方式</h2><p><strong>内部音乐主控：</strong>联动台播放音乐，以实际播放位置驱动编排。</p><p><strong>P1 跟随：</strong>P1 播放音乐，联动台接收 MTC 跟随。时间码异常时冻结自动 Cue，不自动切换主控。</p><h3>关于灯光同步</h3><p>播放期间的灯光编辑暂存于本地。停止后，按同步设置核对并写入；存在冲突或连接错误时需要处理提示。官网演示展示离线编辑，不代表实体控台已完成现场验收。</p><a class="text-link" href="mailto:info@jinhefilm.com">联系接入支持 ↗</a></section></div></div>`);
}

const support = '<a href="mailto:info@jinhefilm.com">info@jinhefilm.com</a>';
const legal = {
  terms: ['服务条款', '团播联动台软件授权与使用条款。购买、激活或使用本软件前，请阅读并确认以下内容。', [
    ['适用范围', `<p>本条款适用于团播联动台 Windows 桌面软件（以下简称“本软件”）的购买、激活、更新与使用，以及本网站提供的购买和订单服务。勾选同意并提交订单、激活或使用本软件，即表示你已阅读并接受本条款、<a href="/refund/">退款政策</a>和<a href="/privacy/">隐私政策</a>。代表公司购买的，你应已获得该公司授权。</p>`],
    ['授权内容', `<ul><li>本软件按授权周期销售：月付授权 30 天，年付授权 365 天，价格以下单时页面显示为准。全部功能包含在授权内，没有免费版或试用。</li><li>每份授权只绑定一台电脑。一台电脑需要一份授权，备用电脑也需单独购买。</li><li>授权期限自付款经服务端核实并交付激活码时起算，不从安装或首次激活起算。期限内可获得本软件的更新版本。</li><li>授权为非独占、不可转让、不可再许可的使用许可。购买授权不转移本软件的任何知识产权。</li><li>本软件每次启动需要联网验证授权。验证失败时无法进入工作区，可在网络恢复后重试。演出运行期间不会因授权到期或断网而被强制停止。</li></ul>`],
    ['购买与交付', `<ul><li>下单无需注册账号。订单凭据用于恢复订单和领取激活码，相当于领取密码，请自行妥善保存，不要转发。</li><li>付款通过支付宝完成。是否付款成功以服务端核实支付渠道结果为准，未核实到账前不会交付激活码。</li><li>领取权限自订单创建起 7 天内有效，请及时领取激活码。付款后未收到激活码的，请提供订单号联系 ${support}。</li></ul>`],
    ['续费与换机', `<ul><li>续费需主动办理，不自动扣款。续费在已激活的电脑上通过软件内购买入口办理，沿用原授权并延长期限。</li><li>更换电脑或重装系统需要迁移授权，请联系支持办理，不能在另一台电脑上直接重复激活。</li></ul>`],
    ['使用要求', `<p>使用本软件时，你不得：</p><ul><li>破解、绕过或篡改授权验证，或对本软件进行反向工程、反编译、反汇编（法律明确允许的除外）；</li><li>出租、出借、转售、分享激活码或订单凭据，或让多台电脑共用同一份授权；</li><li>将本软件用于违反法律法规或侵犯他人合法权益的活动。</li></ul><p>你对直播内容及其使用的音乐、视频、图片等素材的合法性自行负责，并应确保已取得相应授权。</p>`],
    ['第三方软件与设备', `<p>本软件可与 OBS Studio、P1、grandMA2 等第三方软件和设备联动。这些软件、设备及其许可由你自行取得，并受其各自条款约束。本软件不负责账号登录、开播、关播、推流或录像。设备型号、版本和网络环境可能影响联动效果，正式使用前请按实际环境排练验证。</p>`],
    ['现场使用与风险', `<p>本软件用于直播现场的节目编排与设备联动。我们会尽力保证软件稳定，但不承诺软件在任何环境下都不中断、不出错。请在正式演出前完成排练，保留工程备份，并为关键环节准备人工处理方案。时间码丢失或异常时，软件会暂停自动执行，不会猜测或补执行。</p>`],
    ['责任限制', `<p>在法律允许的范围内，对于因使用或无法使用本软件造成的间接损失、利润损失、直播中断或数据丢失，我们不承担赔偿责任。我们就本软件承担的全部责任，以你为相关授权最近一期实际支付的费用为限。法律另有强制规定的，从其规定。</p>`],
    ['授权终止', `<p>授权期限届满且未续费时，授权自动终止。你违反本条款（例如破解授权或分享激活码）的，我们可以撤销相应授权，已付费用不予退还。退款完成的订单，对应授权同时撤销。</p>`],
    ['条款更新', `<p>我们可能根据产品和法律要求更新本条款，更新后在本页公布并注明更新日期。更新涉及你重大权益的，会在网站显著位置提示。更新后继续使用本软件，视为接受更新后的条款。</p>`],
    ['法律适用与争议解决', `<p>本条款适用中华人民共和国法律（不含港澳台地区法律）。发生争议的，双方应先友好协商；协商不成的，任何一方均可向有管辖权的人民法院提起诉讼。</p>`],
    ['联系我们', `<p>对本条款有任何疑问，请联系 ${support}。</p>`]
  ]],
  refund: ['退款政策', '说明可以退款的情形、办理方式和处理时间。', [
    ['可以全额退款的情形', `<ul><li><strong>未激活：</strong>付款后 7 天内，激活码尚未在任何电脑上激活的，可申请全额退款。</li><li><strong>重复付款：</strong>同一订单重复付款，或实付金额高于订单金额的，退还多付部分。</li><li><strong>续费未生效：</strong>续费订单在新增期限开始前申请的，可全额退款。</li></ul>`],
    ['已激活的授权', `<p>本软件为在线交付的计算机软件，激活后依法不适用七日无理由退货。已激活的授权原则上不予退款，但以下情形除外：</p><ul><li>因本软件自身缺陷，导致授权期内无法使用主要功能，我们在收到你的反馈后 15 个工作日内仍未修复、也未提供可行替代方案的，按授权剩余天数比例退款；</li><li>法律法规规定应当退款的其他情形。</li></ul><p>以下情形不属于本软件缺陷：电脑、网络或第三方软件和设备不符合<a href="/guide/">使用指南</a>中的要求；你违反<a href="/terms/">服务条款</a>导致授权被撤销。</p>`],
    ['如何申请', `<ol><li>发送邮件至 ${support}，写明订单号和退款原因。请不要发送订单凭据或完整激活码。</li><li>我们会在 3 个工作日内回复审核结果。需要排查软件问题的，可能请你提供运行日志。</li><li>审核通过后，退款原路退回付款账户，到账时间以支付渠道为准。</li></ol>`],
    ['退款后的处理', `<ul><li>退款完成后，对应激活码和授权同时撤销，软件下次启动时将无法通过验证。部分退款的，按退款金额相应缩短或撤销授权。</li><li>已开具发票的，需先按规定办理发票退回或冲红，再完成退款。</li></ul>`],
    ['联系我们', `<p>对退款有任何疑问，请联系 ${support}。</p>`]
  ]],
  privacy: ['隐私政策', '说明我们在官网、购买服务和桌面软件授权功能中处理哪些个人信息，以及你的权利。', [
    ['适用范围', `<p>本政策适用于本网站（tuanbo-link.jinhefilm.com）、购买与订单服务，以及团播联动台桌面软件中的授权验证、购买和更新功能。</p>`],
    ['我们收集的信息', `<ul><li><strong>下单：</strong>购买人或公司名称、个人或公司类型、套餐、电脑数量、金额、订单号和下单时间。用于生成订单、交付激活码、售后服务和财务记录。</li><li><strong>付款：</strong>支付宝返回的交易号、付款状态、金额和时间，用于核实付款。我们不会接触你的支付宝账号、密码或银行卡信息。</li><li><strong>激活与启动验证：</strong>机器标识、授权编号和请求时间，用于把授权绑定到一台电脑并验证授权。机器标识由 Windows 安装标识经不可逆摘要算法生成，软件不会上传原始标识。</li><li><strong>开票：</strong>你申请发票时提供的发票抬头、纳税人识别号和接收方式，仅用于开具发票。</li><li><strong>联系支持：</strong>你的邮箱地址和来往邮件内容，以及你主动提供的运行日志，用于答复和排查问题。</li><li><strong>访问与安全：</strong>服务器访问日志中的 IP 地址、访问时间、请求地址和浏览器信息，用于安全防护、限制异常请求和故障排查。IP 地址不会写入订单记录。</li></ul>`],
    ['我们不收集的信息', `<ul><li>购买和使用都不需要注册账号，我们不收集手机号码或身份证件信息。</li><li>桌面软件不会上传你的工程文件、媒体素材、直播内容或设备密码。OBS 等设备密码只用 Windows 安全存储保存在你的电脑上。</li><li>本网站和桌面软件不包含广告、第三方统计工具或第三方追踪代码，网站不使用 Cookie。</li></ul>`],
    ['浏览器中的订单凭据', `<p>购买页使用浏览器的会话存储，在当前标签页内暂存订单领取凭据，关闭标签页后自动清除。你下载的订单凭据文件由你自行保管。</p>`],
    ['信息共享与委托处理', `<ul><li><strong>支付宝：</strong>为完成收款，我们向支付宝提交订单号、金额和商品名称，不提交你的购买人名称、激活码或订单凭据。支付宝对付款信息的处理适用其隐私政策。</li><li><strong>云服务器：</strong>网站、订单和授权服务部署在中国境内的云服务器上。</li><li>我们不会出售你的个人信息。除上述情形外，只有在取得你的同意，或法律法规、司法和行政机关依法要求时，才会对外提供。</li></ul>`],
    ['存储地点与期限', `<ul><li>你的个人信息存储在中华人民共和国境内，不向境外传输。</li><li>订单、付款和发票记录按会计与税务法规要求的期限保存。</li><li>授权记录在授权有效期内，以及到期后处理售后和争议所需的期间内保存。</li><li>服务器访问日志按周期自动轮转删除。超出保存期限的信息，我们会删除或匿名化处理。</li></ul>`],
    ['安全措施', `<p>网站和接口全程使用 HTTPS 加密传输。激活码在服务器上加密存储，订单领取凭据只保存校验摘要。运营后台实行账号权限控制和二次验证，所有操作留有审计记录。数据备份加密保存。</p>`],
    ['你的权利', `<p>你可以联系 ${support}，查阅、复制、更正或删除你的个人信息，也可以撤回同意。我们会在核实你与订单的关系后，在 15 个工作日内处理。依法必须保存的财务记录，在保存期限届满前无法删除，但我们会停止除保存以外的其他处理。</p>`],
    ['未成年人', `<p>本软件面向直播团队和企业用户。未满 14 周岁的未成年人不应购买本软件或提交个人信息。</p>`],
    ['政策更新', `<p>我们可能更新本政策，更新后在本页公布并注明更新日期。涉及处理目的、方式或信息种类等重大变化的，会在网站显著位置提示。</p>`],
    ['联系我们', `<p>对本政策或个人信息处理有任何疑问、意见或投诉，请联系 ${support}。</p>`]
  ]]
};

export const LEGAL_PAGES = Object.keys(legal);

export function legalPage(slug) {
  const [title, lead, sections] = legal[slug];
  return layout(title, `/${slug}/`, `<section class="wrap page-intro legal-intro"><h1>${title}</h1><p class="lead">${lead}</p><p class="fine">更新日期：2026 年 10 月 14 日</p></section><article class="wrap legal">${sections.map(([heading, html]) => `<section><h2>${heading}</h2>${html}</section>`).join('')}</article>`);
}

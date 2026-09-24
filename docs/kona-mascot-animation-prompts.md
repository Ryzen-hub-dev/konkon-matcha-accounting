# 小抹 / KONA 动画制作提示词

## 角色身份锁定

始终使用 `public/media/mascot/kona-base-v1.png` 作为唯一人物身份参考，并使用 `public/media/mascot/kona-animation-model-sheet-v1.png` 校准正面、侧面、背面、服装与尾巴结构。

必须保持：成年女性动漫角色、琥珀色眼睛、深森林绿短发与奶油色发尾、同样的狐耳与尾巴、米白与深绿色现代羽织围裙、黄铜账本扣、黑色短靴、腰侧收据卷盒、同样的脸型和身体比例。账本平板不得出现可读文字。

## 网站主循环动画（推荐）

```text
Use the supplied KONA mascot image as the sole identity reference. Create a premium 8-second seamless website hero loop. KONA is an adult anime-style matcha fox bookkeeping assistant standing in a calm three-quarter pose. Preserve her exact face, amber eyes, forest-green bob hair with cream tips, fox ears, tail, cream-and-forest haori apron, brass clasp, black boots, receipt-roll crossbody case, body proportions and color palette.

Motion is restrained and believable: subtle breathing, one natural blink, a small ear twitch, a gentle tail sway with secondary follow-through, then she raises the blank ledger tablet slightly and gives one confident welcoming nod. The receipt case and clothing straps respond with very small physical secondary motion. End on the exact opening pose so the loop is seamless.

Camera is locked, full body remains visible, no zoom, no cut, no camera shake. Clean deep forest-green studio background with a faint non-readable accounting grid, soft directional light, premium Japanese retail technology mood, crisp silhouette, 4K, 24 fps. Keep the left half calmer for website copy. No spoken dialogue and no readable text.
```

## 商品卡片横幅动画

```text
Animate the supplied KONA mascot without changing her identity. 6-second seamless 16:9 product-card loop. Place KONA on the right third, waist-up, holding her blank ledger tablet. She looks toward the product area on screen-left, blinks once, gently taps the tablet, then returns to the starting pose. Dark forest-green accounting workspace in the background, softly out of focus, with abstract inventory rows and receipt shapes only. No readable UI, no copied logos, no camera movement, no exaggerated anime effects. Preserve large empty space on the left for product name and price added later in HTML.
```

## 等待／处理中动画

```text
Using the supplied KONA reference, create a 4-second seamless assistant loop. Preserve every identity and costume detail. KONA studies the blank ledger tablet, her eyes move naturally across it, one ear tilts slightly, and the receipt roll rotates by a tiny amount before stopping. Calm focused expression, subtle breathing, fixed camera, full clean silhouette, no running, no floating icons, no text, no glow, no scene cut. Return precisely to the first frame.
```

## 错误提示动画

```text
Using the supplied KONA reference, create a restrained 4-second error-state loop. Preserve her exact identity and outfit. KONA notices an issue on the blank tablet, makes a small concerned expression, lowers one ear slightly, then gives a reassuring nod and returns to neutral. Keep the response professional and gentle, not comedic or distressed. Fixed camera, no red X, no punctuation, no floating effects, no text, no identity drift, seamless ending.
```

## 通用负面提示词

```text
identity drift, different face, childlike proportions, sexualized pose, changed hairstyle, changed eye color, missing fox ears, extra ears, extra tail, missing tail, extra fingers, fused fingers, broken hands, changing costume, changing accessories, unreadable body anatomy, readable text, logos, watermark, subtitles, floating icons, magic particles, excessive glow, motion blur, camera shake, zoom, jump cut, cropped feet, cropped ears, duplicated body parts, background flicker, inconsistent lighting, non-seamless loop
```

## 输出建议

- 网站首屏：`3840×2160`、24 fps、8 秒、无声、H.264 MP4。
- 手机版：`2160×3840`，重新构图，不要直接裁掉耳朵或尾巴。
- 需要透明视频时优先导出 ProRes 4444 或带 Alpha 的 WebM；工具不支持 Alpha 时使用纯色背景后期抠像。
- 首尾帧必须一致，网页循环才不会跳动。

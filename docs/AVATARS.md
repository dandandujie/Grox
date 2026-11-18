# 1-bit 像素头像

[English](AVATARS.en.md)

Grox 根据助理名称生成确定性的 32 × 32 头像，只使用黑白两色。22 种设计通过头型、发型、眼镜和衣领区分。侧边栏、对话标题、资料、通话面板与频道成员列表共用同一绘制逻辑。

![Grox 头像图册](screenshots/avatars.png)

在网页预览中添加 `?avatars=1` 可查看缩小到联系人列表尺寸后的效果。绘制逻辑位于 `src/lib/pixel-avatar.ts`，渲染由 `PixelAvatar` 负责。

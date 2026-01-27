# Claude Rules for The Canna Bar Project

## MANDATORY: Minimum Text Sizes

**NEVER use tiny text sizes.** The following sizes are BANNED:

- `text-[8px]` - BANNED
- `text-[9px]` - BANNED
- `text-[10px]` - BANNED
- Any custom pixel size below 12px - BANNED

### Minimum Allowed Sizes

- **Mobile (default)**: `text-xs` (12px) minimum
- **Desktop (lg:)**: `text-sm` (14px) minimum

### For body/paragraph text:

- Mobile: `text-sm` (14px) or larger
- Desktop: `text-base` (16px) or larger

### Correct Usage Examples

```html
<!-- WRONG - TOO SMALL -->
<p class="text-[9px] lg:text-[10px]">Brand names here</p>

<!-- CORRECT -->
<p class="text-xs lg:text-sm">Brand names here</p>
```

```html
<!-- WRONG - TOO SMALL -->
<p class="text-[8px] lg:text-[10px]">Footer disclaimer text</p>

<!-- CORRECT -->
<p class="text-sm lg:text-base">Footer disclaimer text</p>
```

## Why This Matters

Small text:
- Is unreadable on mobile devices
- Fails accessibility standards
- Looks unprofessional
- Frustrates users

**When in doubt, make it bigger.**

# Departments

[简体中文](DEPARTMENTS.md)

Bots can belong to a department, and the sidebar groups the roster by that label. This is a local
organizational layer, not an organization account: there are no roles, permissions, shared libraries or
hosted members.

## Behavior

- Every bot has a department string; the default is General.
- New bot and the profile editor can change it.
- The sidebar shows department headers only when more than one department is present.
- Bot ordering inside a department keeps the existing pinned/hidden order.
- Team packages carry the department value.

Standalone department records now exist in AppState.Departments. Settings -> Departments can add an empty
shelf, rename it (bots using the old name move with it), or delete it (bots move to General). General cannot
be renamed or deleted. The sidebar shows an empty department with a "No bots yet" line.

## Not ported

- Department rename/delete actions independent of bots.
- Department sharing, access control, admin ownership and organization libraries.
- Team Cloud departments and hosted member directories.

## Files

- internal/model/types.go - Bot.Department, CreateBotInput.Department, BotPatch.Department
- internal/service/bots.go - default and patch handling
- internal/store/store.go - migration default
- src/components/NewBotDialog.tsx and BotPanel.tsx - editing
- src/components/Sidebar.tsx - grouped roster

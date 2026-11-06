import { ExportDialog, ImportDialog } from '@/features/import-export/ExternalDialogs'
import { MigrationExportDialog } from '@/features/migration/MigrationExportDialog'
import { MigrationImportDialog } from '@/features/migration/MigrationImportDialog'
import {
  ChangePasswordDialog,
  CleanupDialog,
  DeleteVaultDialog,
  ResetVaultDialog
} from '@/features/preferences/AccountDialogs'
import { useUiStore } from '@/stores/ui'

export function Dialogs(): React.JSX.Element {
  const dialog = useUiStore((state) => state.dialog)
  const close = useUiStore((state) => state.closeDialog)

  return (
    <>
      <ChangePasswordDialog open={dialog === 'changePassword'} onClose={close} />
      <ResetVaultDialog open={dialog === 'resetVault'} onClose={close} />
      <DeleteVaultDialog open={dialog === 'deleteVault'} onClose={close} />
      <CleanupDialog open={dialog === 'cleanup'} onClose={close} />
      <MigrationExportDialog open={dialog === 'migrationExport'} onClose={close} />
      <MigrationImportDialog open={dialog === 'migrationImport'} onClose={close} />
      <ImportDialog open={dialog === 'import'} onClose={close} />
      <ExportDialog open={dialog === 'export'} onClose={close} />
    </>
  )
}

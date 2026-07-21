import { Page, BlockStack } from "@shopify/polaris";
import { TitleBar } from "@shopify/app-bridge-react";

export interface PageShellProps {
  title: string;
  /** Primary action button in TitleBar */
  primaryAction?: {
    content: string;
    url?: string;
    onAction?: () => void;
    disabled?: boolean;
  };
  /** Secondary actions - shown in overflow when provided */
  secondaryActions?: Array<{
    content: string;
    url?: string;
    onAction?: () => void;
  }>;
  /** Back navigation - show back button */
  backAction?: { url?: string; onAction?: () => void };
  children: React.ReactNode;
}

export function PageShell({
  title,
  primaryAction,
  secondaryActions,
  backAction,
  children,
}: PageShellProps) {
  const titleBarPrimary = primaryAction
    ? {
        content: primaryAction.content,
        ...(primaryAction.onAction
          ? { onAction: primaryAction.onAction }
          : primaryAction.url
            ? { url: primaryAction.url }
            : {}),
        ...(primaryAction.disabled && { disabled: true }),
      }
    : undefined;

  const titleBarBack = backAction
    ? backAction.onAction
      ? { onAction: backAction.onAction }
      : backAction.url
        ? { url: backAction.url }
        : undefined
    : undefined;

  return (
    <Page fullWidth>
      <TitleBar
        title={title}
        backAction={titleBarBack}
        primaryAction={titleBarPrimary}
        secondaryActions={secondaryActions}
      />
      <BlockStack gap="400">
        {children}
      </BlockStack>
    </Page>
  );
}

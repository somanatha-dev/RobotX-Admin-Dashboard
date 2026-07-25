import { cva } from 'class-variance-authority'

export const badgeVariants = cva(
  'inline-flex items-center rounded-md border border-border/60 px-2.5 py-1 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'bg-muted text-foreground hover:bg-muted/70',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80',
        outline: 'bg-background text-foreground',
        destructive: 'bg-destructive text-destructive-foreground',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
)

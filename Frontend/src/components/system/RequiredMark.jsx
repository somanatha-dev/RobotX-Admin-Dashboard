/**
 * The asterisk after a required field's label.
 *
 * Hidden from assistive technology: the input itself carries `required`, which is what a
 * screen reader announces. This is the visual half, so an operator can tell a required
 * field from an optional one without trying to submit.
 */
export function RequiredMark() {
  return (
    <span aria-hidden className="text-destructive font-normal">
      *
    </span>
  );
}

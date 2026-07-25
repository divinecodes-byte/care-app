import { Alert } from 'react-native';

// Prevents two failed requests (e.g. a slow reminders fetch and a slow
// logs fetch both erroring around the same moment) from queueing two
// native alerts back-to-back — a second alert while one is already
// showing is silently dropped rather than stacked. There is no supported
// way to query "is a native Alert currently visible" on either platform,
// so this tracks it ourselves; it resets as soon as the user dismisses
// the current alert (any button) so a genuinely new, later failure can
// still show its own alert.
let alertShowing = false;

export function showAlertOnce(
    title: string,
    message?: string,
    buttons?: Array<{ text: string; onPress?: () => void; style?: 'default' | 'cancel' | 'destructive' }>
): void {
    if (alertShowing) return;
    alertShowing = true;

    const wrappedButtons = (buttons && buttons.length > 0 ? buttons : [{ text: 'OK' }]).map((b) => ({
        ...b,
        onPress: () => {
            alertShowing = false;
            b.onPress?.();
        },
    }));

    Alert.alert(title, message, wrappedButtons);
}

import argparse
import time

import pyatspi


def descendants(root):
    pending = [root]
    visited = 0
    while pending and visited < 5000:
        current = pending.pop()
        visited += 1
        yield current
        try:
            pending.extend(current.getChildAtIndex(index) for index in range(current.childCount))
        except (RuntimeError, LookupError):
            continue


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("title")
    parser.add_argument("mode", choices=["cancel", "select"])
    args = parser.parse_args()
    expected = {"cancel"} if args.mode == "cancel" else {"select", "open", "select folder"}
    deadline = time.monotonic() + 20
    observed = set()
    while time.monotonic() < deadline:
        desktop = pyatspi.Registry.getDesktop(0)
        for application in desktop:
            if application is None:
                continue
            for dialog in application:
                if dialog is None or dialog.name != args.title:
                    continue
                matches = []
                for control in descendants(dialog):
                    try:
                        if control.getRole() != pyatspi.ROLE_PUSH_BUTTON:
                            continue
                        name = control.name.replace("_", "").strip().lower()
                        observed.add(name)
                        state = control.getState()
                        if name in expected and state.contains(pyatspi.STATE_ENABLED) and state.contains(pyatspi.STATE_SHOWING):
                            matches.append(control)
                    except (RuntimeError, LookupError):
                        continue
                if len(matches) == 1:
                    action = matches[0].queryAction()
                    if action.nActions < 1 or not action.doAction(0):
                        raise RuntimeError("Native confirmation action failed")
                    print(f"Invoked native {args.mode}; observed buttons: {sorted(observed)}", flush=True)
                    return
        time.sleep(0.1)
    raise RuntimeError(f"No unique enabled {args.mode} control in {args.title}; buttons: {sorted(observed)}")


if __name__ == "__main__":
    main()
#!/bin/sh

#
# © 2021 Thoughtworks, Inc.
#

branch="$(git rev-parse --abbrev-ref HEAD)"

if [ "$branch" != "trunk" ]; then
    if [ -t 1 ]; then
        # We're running interactive
        printf "Are you sure you want to use a branch that isn't trunk? (y/n): "
        read -r REPLY < /dev/tty
    else
        # We're running non-interactive (possibly called by IDE)
        echo "This is not the trunk branch and we assume that's intended."
        REPLY="Y"
    fi
    echo
    # POSIX sh: "[ ... =~ ... ]" is not valid in dash or in bash's test builtin.
    case "$REPLY" in
        [Yy]*)
            echo "Okie dokie. Be Careful out there :)"
            exit 0
            ;;
    esac

    echo "Commit aborted. Head on back to the trunk :)"
    exit 1
fi

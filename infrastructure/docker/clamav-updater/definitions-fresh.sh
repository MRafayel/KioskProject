#!/bin/sh
# Readiness gate for the signature updater.
#
# The base image bakes a signature database in at image-build time, and Docker
# seeds an empty signature volume from the image's own directory. So on a first
# run the files exist within milliseconds of start, on definitions that are as
# old as the pinned image digest — weeks, once the pin has aged. A gate that
# only asks whether the files are present therefore reports Healthy long before
# freshclam has downloaded anything, and every service that waits on this one
# starts against a database the document processor will refuse as stale.
#
# This checks the same quantity the processor checks: the database build time,
# against the same age limit. Nothing downstream starts until freshclam has
# actually made the definitions current.
set -eu

max_hours="${CLAMAV_DEFINITION_MAX_AGE_HOURS:-36}"

# The daemon must be alive, not merely have left files behind.
pidof freshclam >/dev/null

test -s /var/lib/clamav/main.cvd

# freshclam replaces the shipped daily.cvd with an incrementally patched
# daily.cld, so either name may be the current one.
database=$(ls /var/lib/clamav/daily.cld /var/lib/clamav/daily.cvd 2>/dev/null | head -1)
test -n "$database"

built=$(sigtool --info "$database" 2>/dev/null | sed -n 's/^Build time: //p')
test -n "$built"

age=$(($(date -u +%s) - $(date -u -d "$built" +%s)))
test "$age" -lt $((max_hours * 3600))

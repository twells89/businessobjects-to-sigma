#!/usr/bin/env python3
import os, sys
here = os.path.dirname(os.path.abspath(__file__))
target = os.path.join(here, '..', 'skills', 'businessobjects-to-sigma', 'scripts', 'seed-xmlresume-snowflake.py')
os.execv(sys.executable, [sys.executable, target, *sys.argv[1:]])

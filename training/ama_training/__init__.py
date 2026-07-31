"""Tinker fine-tuning pipeline for the segov.dev AMA chatbot.

Turns the Neon trace export (see export/export-traces.mjs) into supervised
training runs on Tinker. Model-specific choices (renderer, example
construction, masking) live in ama_training.train presets; everything else is
shared so future open-weight models are a new preset, not a new pipeline.
"""

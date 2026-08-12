"""Ontology domain models and compatibility exports."""

from .canonical import (
    ONTOLOGY_PACKAGE_JSON_SCHEMA,
    SCHEMA_URL,
    SCHEMA_VERSION,
    OntologyPackage,
    ValidationFinding,
    ValidationReport,
    build_package,
    export_package,
    package_from_dict,
    validate_package,
)

__all__ = [
    "ONTOLOGY_PACKAGE_JSON_SCHEMA",
    "SCHEMA_URL",
    "SCHEMA_VERSION",
    "OntologyPackage",
    "ValidationFinding",
    "ValidationReport",
    "build_package",
    "export_package",
    "package_from_dict",
    "validate_package",
]

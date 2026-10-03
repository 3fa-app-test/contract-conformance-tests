import "@typespec/json-schema";
using TypeSpec.JsonSchema;

namespace ThreeFaAuthFactorPolicy;

@id("AuthFactorPolicyV1")
model AuthFactorPolicyV1 {
  @minValue(1)
  @maxValue(1)
  version: integer;

  @minLength(1)
  @maxLength(80)
  label: string;

  @minValue(1)
  @maxValue(3)
  factor_count: integer;

  enabled?: boolean;
}

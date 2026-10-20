#include "oreslang/types/RealtimeAnalysis.hpp"

#include <cstdint>
#include <memory>
#include <stdexcept>
#include <string>

using namespace oreslang;

namespace {

void require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

std::unique_ptr<Expression> integer(std::int64_t value) {
    auto expression = std::make_unique<Expression>();
    expression->kind = Expression::Kind::Integer;
    expression->integer = value;
    return expression;
}

std::unique_ptr<Expression> call(const std::string& name) {
    auto expression = std::make_unique<Expression>();
    expression->kind = Expression::Kind::Call;
    expression->name = name;
    return expression;
}

Function pure(const std::string& name, std::unique_ptr<Expression> result) {
    Function function;
    function.name = name;
    function.result = std::move(result);
    return function;
}

} // namespace

int main() {
    {
        Program program;
        program.functions.push_back(pure("leaf", integer(42)));
        program.functions.push_back(pure("middle", call("leaf")));
        program.functions.push_back(pure("main", call("middle")));

        const auto report = analyze_native_hard_rt(program);
        require(report.source_admitted, "pure transitive graph should admit");
        require(report.reachable_functions == 3, "reachable function count");
        require(report.max_call_depth == 3, "transitive call depth");
        require(report.transitive_effects.bits == 0, "pure graph effects");
        require(report.to_json().find("\"source_admitted\": true") != std::string::npos,
                "machine report admission");
        require(report.to_json().find("\"artifact_certified\": false") != std::string::npos,
                "compiler analysis must not certify final artifact");
    }

    {
        Program program;
        Function allocated = pure("uses_array", integer(1));
        LocalBinding local;
        local.name = "items";
        local.int_array = true;
        allocated.locals.push_back(std::move(local));
        program.functions.push_back(std::move(allocated));
        program.functions.push_back(pure("main", call("uses_array")));

        const auto report = analyze_native_hard_rt(program);
        require(!report.source_admitted, "allocation must reject");
        require(report.diagnostic == "RT001_UNBOUNDED_ALLOCATION",
                "allocation diagnostic");
    }

    {
        Program program;
        Function io = pure("io_capable", integer(1));
        io.has_declared_effects = true;
        io.declared_effects.bits =
            static_cast<std::uint32_t>(FunctionEffect::Io);
        program.functions.push_back(std::move(io));
        program.functions.push_back(pure("main", call("io_capable")));

        const auto report = analyze_native_hard_rt(program);
        require(!report.source_admitted, "declared IO capability must reject");
        require(report.reason.find("disallowed capability") != std::string::npos,
                "declared capability reason");
    }

    {
        Program program;
        program.functions.push_back(pure("loop_a", call("loop_b")));
        program.functions.push_back(pure("loop_b", call("loop_a")));
        program.functions.push_back(pure("main", call("loop_a")));

        const auto report = analyze_native_hard_rt(program);
        require(!report.source_admitted, "recursive graph must reject");
        require(report.diagnostic == "RT008_UNBOUNDED_LOOP",
                "recursion diagnostic");
    }

    {
        Program program;
        Function bounded = pure("bounded", integer(1));
        bounded.scalar_while = std::make_unique<ScalarWhileLoop>();
        bounded.scalar_while->initial = 4;
        bounded.scalar_while->upper_bound = 20;
        program.functions.push_back(std::move(bounded));
        program.functions.push_back(pure("main", call("bounded")));

        const auto report = analyze_native_hard_rt(program);
        require(report.source_admitted, "literal bounded loop should admit");
        require(report.bounded_loop_iterations == 16,
                "bounded iteration accounting");
    }

    {
        Program program;
        program.functions.push_back(pure("main", call("external")));
        const auto report = analyze_native_hard_rt(program);
        require(!report.source_admitted, "external call must reject");
        require(report.diagnostic == "RT005_DYNAMIC_CODE",
                "external call diagnostic");
    }

    return 0;
}

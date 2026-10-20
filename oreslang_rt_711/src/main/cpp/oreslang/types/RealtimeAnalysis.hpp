#pragma once

#include "oreslang/frontend/Parser.hpp"

#include <algorithm>
#include <cstdint>
#include <functional>
#include <sstream>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <unordered_set>
#include <utility>
#include <vector>

namespace oreslang {

struct RealtimeAnalysisReport {
    bool source_admitted = false;
    bool artifact_certified = false;
    std::string profile = "native-hard-rt";
    std::string entry;
    std::string diagnostic = "RT009_SCHEDULING_UNPROVEN";
    std::string reason = "analysis not run";
    FunctionEffects transitive_effects{};
    std::size_t reachable_functions = 0;
    std::size_t max_call_depth = 0;
    std::uint64_t bounded_loop_iterations = 0;
    bool bounded_cleanup = true;
    bool bounded_calls = true;

    static std::string json_escape(std::string_view value) {
        std::string out;
        out.reserve(value.size() + 8);
        for (const unsigned char ch : value) {
            switch (ch) {
                case '"': out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\n': out += "\\n"; break;
                case '\r': out += "\\r"; break;
                case '\t': out += "\\t"; break;
                default:
                    if (ch < 0x20) {
                        static constexpr char hex[] = "0123456789abcdef";
                        out += "\\u00";
                        out += hex[(ch >> 4) & 0xf];
                        out += hex[ch & 0xf];
                    } else {
                        out += static_cast<char>(ch);
                    }
            }
        }
        return out;
    }

    std::string to_json() const {
        std::ostringstream out;
        out << "{\n"
            << "  \"schema_version\": 1,\n"
            << "  \"profile\": \"" << json_escape(profile) << "\",\n"
            << "  \"entry\": \"" << json_escape(entry) << "\",\n"
            << "  \"source_admitted\": " << (source_admitted ? "true" : "false") << ",\n"
            << "  \"artifact_certified\": false,\n"
            << "  \"certification_status\": \"compiler-admission-only\",\n"
            << "  \"diagnostic\": \"" << json_escape(diagnostic) << "\",\n"
            << "  \"reason\": \"" << json_escape(reason) << "\",\n"
            << "  \"effects_bits\": " << transitive_effects.bits << ",\n"
            << "  \"reachable_functions\": " << reachable_functions << ",\n"
            << "  \"max_call_depth\": " << max_call_depth << ",\n"
            << "  \"bounded_loop_iterations\": " << bounded_loop_iterations << ",\n"
            << "  \"bounded_calls\": " << (bounded_calls ? "true" : "false") << ",\n"
            << "  \"bounded_cleanup\": " << (bounded_cleanup ? "true" : "false") << ",\n"
            << "  \"full_guest_aot_proven\": false,\n"
            << "  \"linked_artifact_audit_required\": true\n"
            << "}\n";
        return out.str();
    }
};

namespace realtime_detail {

inline std::string function_key(std::string_view name, std::size_t arity) {
    return std::string(name) + "/" + std::to_string(arity);
}

struct DirectFacts {
    FunctionEffects effects{};
    std::vector<std::string> calls;
    bool bounded_cleanup = true;
    bool bounded_calls = true;
    bool unsupported_runtime = false;
    std::uint64_t loop_iterations = 0;
};

inline void add_effect(DirectFacts& facts, FunctionEffect effect) {
    facts.effects.bits |= static_cast<std::uint32_t>(effect);
}

inline void scan_expression(const Expression* expr, DirectFacts& facts) {
    if (!expr) return;
    scan_expression(expr->left.get(), facts);
    scan_expression(expr->right.get(), facts);
    for (const auto& argument : expr->arguments)
        scan_expression(argument.get(), facts);

    switch (expr->kind) {
        case Expression::Kind::Call:
            if (expr->type_arguments_present || !expr->type_arguments.empty())
                facts.bounded_calls = false;
            facts.calls.push_back(function_key(expr->name, expr->arguments.size()));
            break;
        case Expression::Kind::ArrayCall:
            // Current native Array<int> runtime may allocate/resize. It is not
            // admitted until lowered onto the fixed-capacity RT arena.
            add_effect(facts, FunctionEffect::Alloc);
            break;
        case Expression::Kind::Field:
            add_effect(facts, FunctionEffect::StateRead);
            break;
        case Expression::Kind::BorrowMut:
        case Expression::Kind::Take:
            add_effect(facts, FunctionEffect::StateWrite);
            break;
        case Expression::Kind::Integer:
        case Expression::Kind::Variable:
        case Expression::Kind::Negate:
        case Expression::Kind::Add:
        case Expression::Kind::Subtract:
        case Expression::Kind::Multiply:
        case Expression::Kind::Copy:
        case Expression::Kind::Share:
        case Expression::Kind::Borrow:
            break;
    }
}

inline void scan_binding(const LocalBinding& binding, DirectFacts& facts) {
    scan_expression(binding.initializer.get(), facts);
    for (const auto& argument : binding.constructor_arguments)
        scan_expression(argument.get(), facts);
    if (binding.heap_owned || binding.int_array)
        add_effect(facts, FunctionEffect::Alloc);
}

inline void scan_statement(const Statement& statement, DirectFacts& facts) {
    scan_expression(statement.expression.get(), facts);
    scan_expression(statement.condition_lhs.get(), facts);
    scan_expression(statement.condition_rhs.get(), facts);
    scan_expression(statement.array_commit_length.get(), facts);
    for (const auto& value : statement.array_commit_values)
        scan_expression(value.get(), facts);
    if (statement.branch_local)
        scan_binding(*statement.branch_local, facts);

    if (statement.kind == Statement::Kind::FieldWrite)
        add_effect(facts, FunctionEffect::StateWrite);
    if (statement.kind == Statement::Kind::ArrayCommitFilled)
        add_effect(facts, FunctionEffect::Alloc);
    if (statement.kind == Statement::Kind::Defer)
        facts.bounded_cleanup = false;

    for (const auto& nested : statement.then_statements)
        scan_statement(nested, facts);
    for (const auto& nested : statement.else_statements)
        scan_statement(nested, facts);
}

inline DirectFacts direct_facts(const Function& function) {
    DirectFacts facts;

    for (const auto& local : function.locals)
        scan_binding(local, facts);
    for (const auto& statement : function.statements)
        scan_statement(statement, facts);
    for (const auto& guard : function.early_returns) {
        scan_expression(guard.lhs.get(), facts);
        scan_expression(guard.rhs.get(), facts);
        scan_expression(guard.result.get(), facts);
    }
    for (const auto& write : function.actor_field_writes) {
        add_effect(facts, FunctionEffect::StateWrite);
        scan_expression(write.expression.get(), facts);
    }
    for (const auto& send : function.actor_sends)
        scan_expression(send.payload.get(), facts);
    scan_expression(function.result.get(), facts);
    scan_expression(function.caught_throw_value.get(), facts);

    if (function.caught_throw_value)
        add_effect(facts, FunctionEffect::Throw);
    if (!function.caught_throw_defers.empty()) {
        facts.bounded_cleanup = false;
        for (const auto& statement : function.caught_throw_defers)
            scan_statement(statement, facts);
    }

    if (!function.actor_spawns.empty()) {
        add_effect(facts, FunctionEffect::Alloc);
        facts.unsupported_runtime = true;
    }
    if (!function.actor_sends.empty() || !function.actor_stops.empty() ||
        !function.actor_actions.empty()) {
        // Mailbox admission and scheduler blocking bounds are not yet carried
        // in this AST, so fail closed for the strict profile.
        add_effect(facts, FunctionEffect::Block);
        facts.unsupported_runtime = true;
    }

    if (function.scalar_while) {
        const auto initial = function.scalar_while->initial;
        const auto upper = function.scalar_while->upper_bound;
        if (upper > initial)
            facts.loop_iterations =
                static_cast<std::uint64_t>(upper) -
                static_cast<std::uint64_t>(initial);
    }

    return facts;
}

inline bool disallowed_effects(FunctionEffects effects, std::string& diagnostic,
                               std::string& reason) {
    if (!effects.valid()) {
        diagnostic = "RT009_SCHEDULING_UNPROVEN";
        reason = "unknown function-effect bit";
        return true;
    }
    if (effects.has(FunctionEffect::Alloc)) {
        diagnostic = "RT001_UNBOUNDED_ALLOCATION";
        reason = "reachable source may allocate outside the fixed RT arena";
        return true;
    }
    if (effects.has(FunctionEffect::Block) ||
        effects.has(FunctionEffect::Io) ||
        effects.has(FunctionEffect::Suspend)) {
        diagnostic = "RT002_UNBOUNDED_BLOCKING";
        reason = "reachable source may block, suspend, or perform unqualified I/O";
        return true;
    }
    if (effects.has(FunctionEffect::Ffi)) {
        diagnostic = "RT007_UNKNOWN_FFI";
        reason = "reachable source permits unqualified FFI";
        return true;
    }
    if (effects.has(FunctionEffect::Throw) ||
        effects.has(FunctionEffect::Raise) ||
        effects.has(FunctionEffect::Panic)) {
        diagnostic = "RT006_UNBOUNDED_CLEANUP";
        reason = "reachable exceptional cleanup bound is not proven";
        return true;
    }
    return false;
}

} // namespace realtime_detail

inline RealtimeAnalysisReport analyze_native_hard_rt(
    const Program& program,
    std::string_view entry = "main/0") {

    RealtimeAnalysisReport report;
    report.entry = std::string(entry);

    if (!program.cooperative_loops.empty()) {
        report.diagnostic = "RT002_UNBOUNDED_BLOCKING";
        report.reason = "standalone cooperative continuation is not yet RT-scheduler qualified";
        return report;
    }
    if (!program.actors.empty()) {
        report.diagnostic = "RT009_SCHEDULING_UNPROVEN";
        report.reason = "source actors await fixed-capacity mailbox/scheduler proof";
        return report;
    }

    std::unordered_map<std::string, const Function*> functions;
    for (const auto& function : program.functions) {
        const auto key =
            realtime_detail::function_key(function.name, function.parameters.size());
        if (!functions.emplace(key, &function).second) {
            report.diagnostic = "RT005_DYNAMIC_CODE";
            report.reason = "duplicate native callable identity";
            return report;
        }
    }

    if (!functions.count(report.entry)) {
        report.diagnostic = "RT005_DYNAMIC_CODE";
        report.reason = "hard-RT entry function is missing";
        return report;
    }

    std::unordered_map<std::string, realtime_detail::DirectFacts> direct;
    for (const auto& [key, function] : functions)
        direct.emplace(key, realtime_detail::direct_facts(*function));

    std::unordered_map<std::string, FunctionEffects> closed_effects;
    std::unordered_map<std::string, std::size_t> closed_depth;
    std::unordered_map<std::string, std::uint64_t> closed_loops;
    std::unordered_set<std::string> active;
    std::unordered_set<std::string> reachable;
    bool bounded_cleanup = true;
    bool bounded_calls = true;
    bool unsupported_runtime = false;
    std::string failure;
    std::string failure_diagnostic;

    std::function<FunctionEffects(const std::string&)> visit =
        [&](const std::string& key) -> FunctionEffects {
        const auto cached = closed_effects.find(key);
        if (cached != closed_effects.end()) return cached->second;
        if (!active.insert(key).second) {
            failure = "recursive call graph is not admitted";
            failure_diagnostic = "RT008_UNBOUNDED_LOOP";
            return {};
        }

        const auto found = functions.find(key);
        if (found == functions.end()) {
            failure = "unresolved or external call: " + key;
            failure_diagnostic = "RT005_DYNAMIC_CODE";
            active.erase(key);
            return {};
        }

        reachable.insert(key);
        const Function* function = found->second;
        auto facts = direct.at(key);
        FunctionEffects effects = facts.effects;
        std::size_t depth = 1;
        std::uint64_t loops = facts.loop_iterations;
        bounded_cleanup = bounded_cleanup && facts.bounded_cleanup;
        bounded_calls = bounded_calls && facts.bounded_calls;
        unsupported_runtime = unsupported_runtime || facts.unsupported_runtime;

        for (const auto& child : facts.calls) {
            const FunctionEffects child_effects = visit(child);
            if (!failure.empty()) {
                active.erase(key);
                return {};
            }
            effects = effects.united(child_effects);
            const auto child_depth = closed_depth.at(child);
            depth = std::max(depth, child_depth + 1);
            const auto child_loops = closed_loops.at(child);
            if (child_loops > UINT64_MAX - loops) {
                failure = "bounded loop count overflow";
                failure_diagnostic = "RT008_UNBOUNDED_LOOP";
                active.erase(key);
                return {};
            }
            loops += child_loops;
        }

        if (function->has_declared_effects) {
            if (!function->declared_effects.valid() ||
                !function->declared_effects.permits(effects)) {
                failure = "declared using-effects do not cover transitive inferred effects for " + key;
                failure_diagnostic = "RT009_SCHEDULING_UNPROVEN";
                active.erase(key);
                return {};
            }
            std::string diagnostic;
            std::string reason;
            if (realtime_detail::disallowed_effects(
                    function->declared_effects, diagnostic, reason)) {
                failure = "hard-RT entry reaches function declaring disallowed capability: " + key;
                failure_diagnostic = diagnostic;
                active.erase(key);
                return {};
            }
        }

        active.erase(key);
        closed_depth.emplace(key, depth);
        closed_loops.emplace(key, loops);
        closed_effects.emplace(key, effects);
        return effects;
    };

    report.transitive_effects = visit(report.entry);
    report.reachable_functions = reachable.size();
    report.bounded_cleanup = bounded_cleanup;
    report.bounded_calls = bounded_calls;

    if (!failure.empty()) {
        report.diagnostic = failure_diagnostic.empty()
            ? "RT009_SCHEDULING_UNPROVEN"
            : failure_diagnostic;
        report.reason = failure;
        return report;
    }

    report.max_call_depth = closed_depth.at(report.entry);
    report.bounded_loop_iterations = closed_loops.at(report.entry);

    if (!report.bounded_calls) {
        report.diagnostic = "RT005_DYNAMIC_CODE";
        report.reason = "generic/dynamic call qualification is not proven";
        return report;
    }
    if (!report.bounded_cleanup) {
        report.diagnostic = "RT006_UNBOUNDED_CLEANUP";
        report.reason = "defer/exception cleanup bound is not proven";
        return report;
    }
    if (unsupported_runtime) {
        report.diagnostic = "RT009_SCHEDULING_UNPROVEN";
        report.reason = "actor runtime scheduling/mailbox bounds are not proven";
        return report;
    }

    if (realtime_detail::disallowed_effects(
            report.transitive_effects, report.diagnostic, report.reason)) {
        return report;
    }

    report.source_admitted = true;
    report.diagnostic = "OK";
    report.reason =
        "source call graph is bounded and contains no currently disallowed hard-RT effects";
    return report;
}

} // namespace oreslang

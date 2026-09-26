use ores_stack_pub_lib_core::{
    InvocationContext, Lambda, ModuleContext, TypedModule,
};

struct AppContext {
    platform: InvocationContext,
    database_name: String,
}

impl ModuleContext for AppContext {
    fn invocation(&self) -> &InvocationContext {
        &self.platform
    }
}

struct Handler;

impl TypedModule for Handler {
    type Kind = Lambda;
    type Input = String;
    type Output = String;
    type Error = ();
    type Context = AppContext;

    const NAME: &'static str = "example";

    async fn handle(
        &self,
        context: &Self::Context,
        input: Self::Input,
    ) -> Result<Self::Output, Self::Error> {
        let request_id = context.invocation().request_id();
        Ok(format!("{request_id}:{}:{input}", context.database_name))
    }
}

fn main() {}

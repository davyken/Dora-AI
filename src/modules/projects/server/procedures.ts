import { z } from "zod";
import { generateSlug } from "random-word-slugs";

import { prisma } from "@/lib/db";
import { TRPCError } from "@trpc/server";
import { inngest } from "@/inngest/client";
import { consumeCredits } from "@/lib/usage";
import { protectedProcedure, createTRPCRouter } from "@/trpc/init";

export const projectsRouter = createTRPCRouter({
  getOne: protectedProcedure
    .input(z.object({
      id: z.string().min(1, { message: "Id is required" }),
    }))
    .query(async ({ input, ctx }) => {
      const existingProject = await prisma.project.findUnique({
        where: {
          id: input.id,
          userId: ctx.auth.userId,
        },
      });

      if (!existingProject) {
        throw new TRPCError({ code: "NOT_FOUND", message: "Project not found" });
      }

      return existingProject;
    }),
  getMany: protectedProcedure
    .query(async ({ ctx }) => {
      const projects = await prisma.project.findMany({
        where: {
          userId: ctx.auth.userId,
        },
        orderBy: {
          updatedAt: "desc",
        },
      });

      return projects;
    }),
  create: protectedProcedure
    .input(
      z.object({
        value: z.string()
          .min(1, { message: "Value is required" })
          .max(10000, { message: "Value is too long" })
      }),
    )
    .mutation(async ({ input, ctx }) => {
      // Try to consume credits
      try {
        await consumeCredits();
      } catch (error) {
        if (error instanceof Error) {
          // Check for specific error messages
          if (error.message.includes("User not authenticated")) {
            throw new TRPCError({ code: "UNAUTHORIZED", message: "Please sign in to create a project" });
          }
          throw new TRPCError({ code: "BAD_REQUEST", message: "Failed to process credit consumption" });
        } else {
          throw new TRPCError({
            code: "TOO_MANY_REQUESTS",
            message: "You have run out of credits"
          });
        }
      }

      // Try to create project in database
      let createdProject;
      try {
        createdProject = await prisma.project.create({
          data: {
            userId: ctx.auth.userId,
            name: generateSlug(2, {
              format: "kebab",
            }),
            messages: {
              create: {
                content: input.value,
                role: "USER",
                type: "RESULT",
              }
            }
          }
        });
      } catch (error) {
        console.error("Database error:", error);
        throw new TRPCError({ 
          code: "INTERNAL_SERVER_ERROR", 
          message: "Failed to create project. Please check your database connection." 
        });
      }

      // Try to send event to Inngest
      try {
        await inngest.send({
          name: "code-agent/run",
          data: {
            value: input.value,
            projectId: createdProject.id,
          },
        });
      } catch (error) {
        console.error("Inngest error:", error);
        // Project was created successfully, just warn about the async task
        // Don't throw error - the project exists and user can check later
      }

      return createdProject;
    }),
});
